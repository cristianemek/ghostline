import { extractSignature } from './symbolText';

/**
 * The project index: what the project itself declares (functions, types and their fields, exported
 * constants), one line each. It goes into the system prompt, where the CLI's prompt cache makes it
 * almost free, so that a suggestion can use a function that exists three files away instead of
 * inventing one (measured in docs/acierto.md). No model is involved in building it and no values
 * are included: every line goes through `extractSignature`.
 */

type Family = 'go' | 'ts' | 'py' | 'rs';

const FAMILY_BY_EXTENSION: Record<string, Family> = {
  go: 'go',
  ts: 'ts',
  tsx: 'ts',
  js: 'ts',
  jsx: 'ts',
  mts: 'ts',
  cts: 'ts',
  mjs: 'ts',
  cjs: 'ts',
  py: 'py',
  rs: 'rs',
};

export const INDEXED_EXTENSIONS = Object.keys(FAMILY_BY_EXTENSION);

/** A line that starts a declaration worth listing, at the top level of a file. */
const TOP_LEVEL: Record<Family, RegExp> = {
  go: /^(?:func|type) /,
  // Only what a module exports: the rest cannot be used from another file.
  ts: /^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let)\b/,
  py: /^(?:async\s+def|def|class) /,
  rs: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type) /,
};

/** Public methods inside a class body, for the languages where methods are not top-level declarations. */
const METHOD: Partial<Record<Family, RegExp>> = {
  ts: /^(?!(?:private|protected|constructor|if|for|while|switch|return)\b)(?:(?:public|static|async|override|readonly)\s+)*(?:(?:get|set)\s+)?[A-Za-z_$][\w$]*\s*(?:<[^>()]*>)?\(/,
  py: /^(?:async\s+)?def\s+(?!_)[A-Za-z]\w*\(/,
};
const CLASS_HEAD: Partial<Record<Family, RegExp>> = {
  ts: /^export\s+(?:default\s+)?(?:abstract\s+)?class\b/,
  py: /^class /,
};

const MAX_DECLARATIONS_PER_FILE = 60;
const MAX_METHODS_PER_CLASS = 20;
/** Lines handed to `extractSignature`: enough for a signature split over lines or the fields of a type. */
const DECLARATION_LINES = 40;

export function isIndexable(path: string): boolean {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  return extension in FAMILY_BY_EXTENSION && !/\.d\.[cm]?ts$/i.test(path);
}

function classMethods(lines: readonly string[], start: number, method: RegExp): string[] {
  const methods: string[] = [];
  let indent: string | undefined;
  for (let index = start; index < lines.length && methods.length < MAX_METHODS_PER_CLASS; index++) {
    const line = lines[index] as string;
    if (line.trim() === '') continue;
    const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
    // Back at the left margin: the class is over.
    if (lead === '') break;
    indent ??= lead;
    if (lead !== indent || !method.test(line.slice(lead.length))) continue;
    const signature = extractSignature(lines.slice(index, index + DECLARATION_LINES), 0);
    if (signature) methods.push(`  ${signature}`);
  }
  return methods;
}

/** The declarations of one source file, one line each (methods indented under their class). */
export function declarationsOf(text: string, path: string): string[] {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  const family = FAMILY_BY_EXTENSION[extension];
  if (!family) return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const declarations: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length && declarations.length < MAX_DECLARATIONS_PER_FILE; index++) {
    const line = lines[index] as string;
    if (!TOP_LEVEL[family].test(line)) continue;
    const signature = extractSignature(lines.slice(index, index + DECLARATION_LINES), 0);
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    declarations.push(signature);
    const method = METHOD[family];
    if (method && CLASS_HEAD[family]?.test(line)) declarations.push(...classMethods(lines, index + 1, method));
  }
  return declarations.slice(0, MAX_DECLARATIONS_PER_FILE);
}

export interface IndexedFile {
  /** Workspace-relative, with forward slashes. */
  path: string;
  declarations: string[];
}

export interface ProjectIndex {
  /** Empty when there is nothing to say. */
  text: string;
  files: number;
  declarations: number;
  /** Files with declarations that did not fit. */
  omitted: number;
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/** How many leading folders two directories share. */
function sharedSegments(a: string, b: string): number {
  const left = a === '' ? [] : a.split('/');
  const right = b === '' ? [] : b.split('/');
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared++;
  return shared;
}

const section = (file: IndexedFile): string => `// ${file.path}\n${file.declarations.join('\n')}`;

/**
 * The index as text, within `maxChars`. A project that fits is listed whole, in path order, so the
 * text is the same whatever file is open and the prompt cache keeps serving it. One that does not
 * fit is listed starting from the folder of the file being edited and moving away from it.
 */
export function buildProjectIndex(files: readonly IndexedFile[], activePath: string | undefined, maxChars: number): ProjectIndex {
  const listed = files.filter((file) => file.declarations.length > 0).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const total = listed.reduce((sum, file) => sum + section(file).length + 1, 0);
  let ordered = listed;
  if (total > maxChars && activePath !== undefined) {
    const home = directoryOf(activePath);
    const rank = (file: IndexedFile): number => {
      const directory = directoryOf(file.path);
      // Same folder first, then the folders closest to it in the tree, nearest first.
      return directory === home ? -1 : -sharedSegments(directory, home) + Math.abs(directory.split('/').length - home.split('/').length) / 100;
    };
    ordered = [...listed].sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : 1));
  }
  const parts: string[] = [];
  let used = 0;
  let declarations = 0;
  for (const file of ordered) {
    const text = section(file);
    // In strict order: a far file is not let in just because it happens to be small.
    if (used + text.length + 1 > maxChars) break;
    parts.push(text);
    used += text.length + 1;
    declarations += file.declarations.length;
  }
  const omitted = listed.length - parts.length;
  if (omitted > 0 && parts.length > 0) parts.push(`// (${omitted} more files not listed)`);
  return { text: parts.join('\n'), files: listed.length - omitted, declarations, omitted };
}

/** The block appended to the system prompt, or '' when the index is empty. */
export function projectBlock(index: ProjectIndex): string {
  if (!index.text) return '';
  return (
    '\n<project>\n' +
    'Functions and types this project declares, by file. Use what exists here instead of inventing names, and call it as declared.\n' +
    `${index.text}\n</project>\n`
  );
}
