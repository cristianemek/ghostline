/** Pure helpers for the "learn the project's style" command. */

export interface StyleCandidate {
  /** Workspace-relative path with forward slashes. */
  path: string;
  /** Size in bytes. */
  size: number;
}

export const SOURCE_EXTENSIONS: readonly string[] = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'py', 'go', 'rs', 'java', 'kt', 'cs', 'rb', 'php',
  'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'dart', 'scala', 'lua', 'sh', 'ex', 'exs',
];

export const IGNORED_FOLDERS: readonly string[] = [
  'node_modules', 'dist', 'build', 'out', '.git', 'vendor', 'target', '.next', '.nuxt', '.venv', 'venv',
  '__pycache__', 'coverage', '.vscode-test', '.idea', 'bin', 'obj',
];

/** Files that say nothing about how the team writes code. */
const NOT_HAND_WRITTEN = /(\.min\.|\.bundle\.|\.generated\.|\.gen\.|_pb2?\.|\.pb\.|\.d\.ts$|-lock\.|\.lock$|\.snap$)/i;
const TEST_FILE = /(\.test\.|\.spec\.|_test\.|(^|\/)(tests?|__tests__|specs?|e2e|fixtures)\/)/i;

/** The profile is sent with every request, so it has to stay small: ~200 tokens. */
export const MAX_PROFILE_CHARS = 700;
/**
 * Budget for the file contents sent when learning the style. With the CLI's fixed overhead the whole
 * request comes to about 6k tokens, the spec's ceiling.
 */
export const STYLE_INPUT_TOKENS = 5200;
/** The heads of source files are dense code (measured: ~2.3 characters per token). */
export const STYLE_CHARS_PER_TOKEN = 2.3;
export const MAX_STYLE_FILES = 5;
const IDEAL_FILE_BYTES = 4000;
const MIN_GOOD_BYTES = 400;
const MAX_GOOD_BYTES = 40_000;

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

export function isStyleCandidate(path: string): boolean {
  return SOURCE_EXTENSIONS.includes(extensionOf(path)) && !NOT_HAND_WRITTEN.test(path);
}

/**
 * Chooses the files that best represent the project's style: the dominant language (or the one being
 * edited), medium-sized hand-written files, spread over different folders, tests last.
 */
export function pickStyleFiles<T extends StyleCandidate>(
  candidates: readonly T[],
  options: { max?: number; preferredExtension?: string } = {},
): T[] {
  const max = options.max ?? MAX_STYLE_FILES;
  const usable = candidates.filter((candidate) => candidate.size > 0 && isStyleCandidate(candidate.path));
  if (usable.length === 0) return [];

  const counts = new Map<string, number>();
  for (const candidate of usable) {
    const extension = extensionOf(candidate.path);
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  const byFrequency = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([extension]) => extension);
  const preferred = options.preferredExtension?.toLowerCase();
  const extensionOrder = preferred && counts.has(preferred) ? [preferred, ...byFrequency.filter((e) => e !== preferred)] : byFrequency;

  const score = (candidate: StyleCandidate): number =>
    // Close to the ideal size is better; tests and tiny or huge files go to the back.
    -Math.abs(Math.log(candidate.size / IDEAL_FILE_BYTES)) - (TEST_FILE.test(candidate.path) ? 5 : 0);

  const picked: T[] = [];
  for (const extension of extensionOrder) {
    if (picked.length >= max) break;
    const ranked = usable
      .filter((candidate) => extensionOf(candidate.path) === extension)
      .sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));
    // Variety matters, but not more than quality: a huge, tiny or test file from a new folder is
    // worse than a second good file from a folder already used.
    const good = ranked.filter(
      (candidate) => candidate.size >= MIN_GOOD_BYTES && candidate.size <= MAX_GOOD_BYTES && !TEST_FILE.test(candidate.path),
    );
    const folders = new Set(picked.map((candidate) => folderOf(candidate.path)));
    for (const candidate of good) {
      if (picked.length >= max) break;
      if (folders.has(folderOf(candidate.path))) continue;
      folders.add(folderOf(candidate.path));
      picked.push(candidate);
    }
    for (const candidate of [...good, ...ranked]) {
      if (picked.length >= max) break;
      if (!picked.includes(candidate)) picked.push(candidate);
    }
  }
  return picked;
}

/** The user message for the style request: the head of each file, sharing the token budget equally. */
export function buildStylePrompt(
  files: ReadonlyArray<{ path: string; content: string }>,
  charsPerToken: number = STYLE_CHARS_PER_TOKEN,
  maxTokens: number = STYLE_INPUT_TOKENS,
): string {
  if (files.length === 0) return '';
  const perFile = Math.max(200, Math.floor((maxTokens * charsPerToken) / files.length) - 80);
  return files
    .map(({ path, content }) => {
      const text = content.replace(/\r\n?/g, '\n');
      let head = text.slice(0, perFile);
      if (head.length < text.length) {
        const lastNewline = head.lastIndexOf('\n');
        if (lastNewline > 0) head = head.slice(0, lastNewline);
      }
      return `<file path="${path.replace(/["\r\n]/g, ' ')}">\n${head.trimEnd()}\n</file>`;
    })
    .join('\n\n');
}

/** Tidies the model's answer into the profile that is stored: no fences, no preamble, capped. */
export function cleanStyleGuide(raw: string, maxChars: number = MAX_PROFILE_CHARS): string {
  let text = raw.replace(/\r\n?/g, '\n').trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = (fenced[1] ?? '').trim();
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    // Headings and "Here is the style guide:" lines carry no convention.
    .filter((line) => !/^#{1,6}\s/.test(line) && !/^(here('s| is| are)|sure\b|style guide:?$)/i.test(line.trim()));
  return capProfile(lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), maxChars);
}

/** Cuts a profile (possibly hand-edited) to the size that is sent, on a line boundary. */
export function capProfile(text: string, maxChars: number = MAX_PROFILE_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');
  return (lastNewline > maxChars / 2 ? cut.slice(0, lastNewline) : cut).trimEnd();
}
