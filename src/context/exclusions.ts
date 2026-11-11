/**
 * Sensitive-file filter. The extension checks documents with `vscode.languages.match` (as the spec
 * asks) AND with this dependency-free matcher, and treats a file as excluded when either says so.
 * This matcher also covers the places where there is only a path and no TextDocument.
 */
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
];

const REGEX_SPECIAL = /[.+^$()|\\]/;

function translate(glob: string): string {
  let out = '';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          // "**/" spans any number of directories, including none.
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '{') {
      braceDepth++;
      out += '(?:';
    } else if (char === '}' && braceDepth > 0) {
      braceDepth--;
      out += ')';
    } else if (char === ',' && braceDepth > 0) {
      out += '|';
    } else if (char === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close < 0) {
        out += '\\[';
      } else {
        const body = glob.slice(i + 1, close).replace(/\\/g, '\\\\');
        out += `[${body.startsWith('!') ? '^' + body.slice(1) : body}]`;
        i = close;
      }
    } else if (REGEX_SPECIAL.test(char)) {
      out += '\\' + char;
    } else {
      out += char;
    }
  }
  return out + ')'.repeat(braceDepth);
}

const compiled = new Map<string, RegExp | null>();

// Glob → RegExp over forward-slash paths. Matching is case-insensitive and a pattern may match
// starting at any directory (a bare "*.pem" behaves as if it had the any-directory prefix):
// erring on the side of excluding too much is the safe direction here.
export function globToRegExp(glob: string): RegExp | null {
  const cached = compiled.get(glob);
  if (cached !== undefined) return cached;
  let regex: RegExp | null = null;
  const normalized = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (normalized) {
    try {
      regex = new RegExp(`^(?:.*/)?${translate(normalized)}$`, 'i');
    } catch {
      regex = null;
    }
  }
  compiled.set(glob, regex);
  return regex;
}

export function isPathExcluded(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, '/');
  return patterns.some((pattern) => globToRegExp(pattern)?.test(normalized) ?? false);
}
