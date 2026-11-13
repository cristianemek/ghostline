const COMMON_WORDS = new Set([
  'abstract', 'and', 'as', 'async', 'await', 'bool', 'boolean', 'break', 'case', 'catch', 'class', 'const',
  'continue', 'def', 'default', 'do', 'double', 'elif', 'else', 'end', 'enum', 'except', 'export', 'extends',
  'false', 'final', 'finally', 'float', 'fn', 'for', 'from', 'func', 'function', 'if', 'implements', 'import',
  'in', 'int', 'interface', 'is', 'let', 'long', 'new', 'nil', 'none', 'not', 'null', 'number', 'of', 'or',
  'package', 'pass', 'private', 'protected', 'pub', 'public', 'readonly', 'return', 'self', 'static', 'string',
  'struct', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'undefined', 'use', 'var', 'void',
  'while', 'with', 'yield',
]);

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

export function identifiers(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(IDENTIFIER)) {
    const word = match[0].toLowerCase();
    if (word.length > 1 && !COMMON_WORDS.has(word)) found.add(word);
  }
  return found;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}
