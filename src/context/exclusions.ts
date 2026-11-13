export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/*secret*',
  '**/*credential*',
  '**/.npmrc',
  '**/.pypirc',
  '**/.netrc',
  '**/.aws/**',
  '**/.ssh/**',
  '**/*.kdbx',
  '**/*secret*/**',
  '**/*credential*/**',
  '**/.git-credentials',
  '**/.gnupg/**',
  '**/.kube/**',
  '**/.docker/config.json',
  '**/*.tfvars',
  '**/*.tfstate',
  '**/*.tfstate.*',
  '**/*.jks',
  '**/*.keystore',
  '**/.htpasswd',
];

const MAX_PATTERN_CHARS = 200;
const MAX_BRACE_EXPANSIONS = 64;

function expandBraces(pattern: string): string[] | null {
  const open = pattern.indexOf('{');
  if (open < 0) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}' && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return [pattern];
  const head = pattern.slice(0, open);
  const body = pattern.slice(open + 1, close);
  const tail = pattern.slice(close + 1);
  const options: string[] = [];
  let start = 0;
  depth = 0;
  for (let i = 0; i <= body.length; i++) {
    const char = body[i];
    if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (i === body.length || (char === ',' && depth === 0)) {
      options.push(body.slice(start, i));
      start = i + 1;
    }
  }
  const results: string[] = [];
  for (const option of options) {
    const expanded = expandBraces(head + option + tail);
    if (!expanded) return null;
    results.push(...expanded);
    if (results.length > MAX_BRACE_EXPANSIONS) return null;
  }
  return results;
}

// globs are matched by hand: a RegExp built from one can hang the editor
function matchOne(pattern: string, index: number, char: string): number {
  const token = pattern[index];
  if (token === '?') return 1;
  if (token === '[') {
    const close = pattern.indexOf(']', index + 2);
    if (close > 0) {
      let body = pattern.slice(index + 1, close);
      const negated = body.startsWith('!') || body.startsWith('^');
      if (negated) body = body.slice(1);
      let found = false;
      for (let i = 0; i < body.length; i++) {
        if (body[i + 1] === '-' && i + 2 < body.length) {
          if (char >= (body[i] as string) && char <= (body[i + 2] as string)) found = true;
          i += 2;
        } else if (body[i] === char) {
          found = true;
        }
      }
      return found !== negated ? close - index + 1 : 0;
    }
  }
  return token === char ? 1 : 0;
}

function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let starPattern = -1;
  let starText = 0;
  while (t < text.length) {
    if (pattern[p] === '*') {
      starPattern = p++;
      starText = t;
      continue;
    }
    const consumed = p < pattern.length ? matchOne(pattern, p, text[t] as string) : 0;
    if (consumed > 0) {
      p += consumed;
      t++;
    } else if (starPattern >= 0) {
      p = starPattern + 1;
      t = ++starText;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
  const width = path.length + 1;
  const memo = new Map<number, boolean>();
  const from = (p: number, s: number): boolean => {
    if (p === pattern.length) return s === path.length;
    const key = p * width + s;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const result =
      pattern[p] === '**'
        ? from(p + 1, s) || (s < path.length && from(p, s + 1))
        : s < path.length && matchSegment(pattern[p] as string, path[s] as string) && from(p + 1, s + 1);
    memo.set(key, result);
    return result;
  };
  return from(0, 0);
}

const compiled = new Map<string, string[][] | null>();

function compile(glob: string): string[][] | null {
  const cached = compiled.get(glob);
  if (cached !== undefined) return cached;
  let result: string[][] | null = null;
  const normalized = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
  if (normalized && normalized.length <= MAX_PATTERN_CHARS) {
    const alternatives = expandBraces(normalized);
    if (alternatives) {
      result = alternatives.map((alternative) => {
        const segments: string[] = [];
        for (const raw of alternative.split('/')) {
          if (!raw) continue;
          const segment = raw === '**' ? raw : raw.replace(/\*{2,}/g, '*');
          if (segment === '**' && segments.at(-1) === '**') continue;
          segments.push(segment);
        }
        if (segments[0] !== '**') segments.unshift('**');
        return segments;
      });
    }
  }
  compiled.set(glob, result);
  return result;
}

export function matchesGlob(glob: string, path: string): boolean {
  const patterns = compile(glob);
  if (!patterns) return false;
  const segments = path.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  return patterns.some((pattern) => matchSegments(pattern, segments));
}

export function isPathExcluded(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, path));
}

export function unusablePatterns(patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => pattern.trim() !== '' && compile(pattern) === null);
}
