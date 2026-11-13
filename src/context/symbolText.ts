import { withoutStructuralTags } from '../completion/promptBuilder';
import { identifiers } from '../learning/similarity';

export const MAX_SYMBOLS = 3;
export const MAX_SYMBOL_TOKENS = 400;
const MAX_SIGNATURE_CHARS = 240;
const MAX_SIGNATURE_LINES = 4;
const MIN_IDENTIFIER_LENGTH = 3;

export interface IdentifierUse {
  name: string;
  character: number;
}

export function pickIdentifiers(linePrefix: string, max: number = MAX_SYMBOLS): IdentifierUse[] {
  const meaningful = identifiers(linePrefix);
  const picked: IdentifierUse[] = [];
  const seen = new Set<string>();
  const matches = [...linePrefix.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)].reverse();
  for (const match of matches) {
    if (picked.length >= max) break;
    const name = match[0];
    if (name.length < MIN_IDENTIFIER_LENGTH || !meaningful.has(name.toLowerCase()) || seen.has(name)) continue;
    const before = linePrefix.slice(0, match.index);
    if (/\/\/|#(?!\w)/.test(before) || ((before.match(/["'`]/g)?.length ?? 0) % 2 === 1)) continue;
    seen.add(name);
    picked.push({ name, character: match.index ?? 0 });
  }
  return picked;
}

export function pickIdentifiersAfter(restOfLine: string, max: number = MAX_SYMBOLS): IdentifierUse[] {
  const code = restOfLine.split(/\/\/|#(?!\w)/)[0] ?? '';
  const meaningful = identifiers(code);
  const picked: IdentifierUse[] = [];
  const seen = new Set<string>();
  for (const match of code.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    if (picked.length >= max) break;
    const name = match[0];
    if (name.length < MIN_IDENTIFIER_LENGTH || !meaningful.has(name.toLowerCase()) || seen.has(name)) continue;
    if ((code.slice(0, match.index).match(/["'`]/g)?.length ?? 0) % 2 === 1) continue;
    seen.add(name);
    picked.push({ name, character: match.index ?? 0 });
  }
  return picked;
}

export interface SymbolLine {
  name: string;
  line: string;
}

export function enclosingOpener(above: readonly string[], linePrefix: string): { linesUp: number; character: number } | undefined {
  let depth = 0;
  const scan = (text: string): number => {
    for (let index = text.length - 1; index >= 0; index--) {
      const char = text[index] as string;
      if (char === ')' || char === ']' || char === '}') depth++;
      else if (char === '(' || char === '[' || char === '{') {
        if (depth === 0) return index;
        depth--;
      }
    }
    return -1;
  };
  if (scan(linePrefix) >= 0) return undefined;
  for (let linesUp = 1; linesUp <= above.length; linesUp++) {
    const text = above[above.length - linesUp] as string;
    const character = scan(text);
    if (character < 0) continue;
    if (text[character] !== '{') return { linesUp, character };
    const before = text.slice(0, character);
    const value = /[\w$\]]$/.test(before) || /[([,=:]\s*$/.test(before) || /\breturn\s*$/.test(before);
    return value ? { linesUp, character } : undefined;
  }
  return undefined;
}

function unclosedParens(text: string): number {
  let depth = 0;
  for (const char of text) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
  }
  return depth;
}

const MAX_TYPE_CHARS = 480;
const MAX_TYPE_MEMBERS = 16;
const MODIFIERS =
  /^(?:(?:export|default|declare|pub(?:\([^)]*\))?|public|private|protected|internal|abstract|sealed|static|final|partial|readonly|unsafe)\s+)+/;
const TYPE_HEADS = [
  /^type\s+[\w$]+(?:\[[^\]]*\])?\s+(?:struct|interface)\s*\{$/,
  /^type\s+[\w$]+(?:<[^{}]*>)?\s*=\s*\{$/,
  /^(?:const\s+)?(?:interface|struct|enum|trait|union)\s+[\w$]+[^{}=;()]*\{$/,
];

function opensTypeBody(line: string): boolean {
  const bare = line.trim().replace(MODIFIERS, '');
  return TYPE_HEADS.some((pattern) => pattern.test(bare));
}

function typeMembers(lines: readonly string[], start: number): { members: string[]; complete: boolean } {
  const members: string[] = [];
  let depth = 1;
  for (let index = start; index < lines.length; index++) {
    const text = (lines[index] ?? '')
      .replace(/\/\*.*?\*\//g, '')
      .replace(/\s*\/\/.*$/, '')
      .trim();
    const depthBefore = depth;
    for (const char of text) {
      if (char === '{') depth++;
      else if (char === '}') depth--;
    }
    if (depth <= 0) return { members, complete: true };
    if (depthBefore !== 1 || text === '' || /^(?:\*|\/\*|#|@)/.test(text)) continue;
    if (members.length >= MAX_TYPE_MEMBERS) return { members, complete: false };
    let member = depth > depthBefore ? `${text.slice(0, text.lastIndexOf('{')).trimEnd()} {…}` : text;
    member = member
      .replace(/\s*`[^`]*`\s*$/, '')
      .replace(/[,;]\s*$/, '')
      .replace(/\s*(?<![=!<>])=(?!>).*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (member) members.push(member);
  }
  return { members, complete: false };
}

export function extractSignature(lines: readonly string[], line: number, members = true): string {
  const head = (lines[line] ?? '').trim();
  if (members && opensTypeBody(head)) {
    const body = typeMembers(lines, line + 1);
    if (body.members.length > 0) {
      const text = `${head.replace(/\s+/g, ' ')} ${body.members.join('; ')}${body.complete ? '' : '; …'} }`.replace(
        /(["'`])(?:\\.|(?!\1)[^\\]){9,}\1/g,
        '$1…$1',
      );
      return text.length > MAX_TYPE_CHARS ? text.slice(0, MAX_TYPE_CHARS - 3) + '… }' : text;
    }
  }
  let signature = head;
  let next = line + 1;
  while (unclosedParens(signature) > 0 && next < lines.length && next - line < MAX_SIGNATURE_LINES) {
    signature += ' ' + (lines[next] ?? '').trim();
    next++;
  }
  signature = signature.replace(/\s*\{\s*\}?\s*$/, '').replace(/\s*=>\s*\{?\s*$/, ' =>').replace(/\s+/g, ' ').trim();
  signature = withoutValues(signature);
  return signature.length > MAX_SIGNATURE_CHARS ? signature.slice(0, MAX_SIGNATURE_CHARS - 1) + '…' : signature;
}

const LITERAL_START = /^\s*(["'`\d[{-]|(?:true|false|null|none|nil|undefined)\b)/i;

function withoutValues(signature: string): string {
  let result = signature;
  const paren = result.indexOf('(');
  const head = paren < 0 ? result : result.slice(0, paren);
  const assignment = /(?<![=!<>])=(?![=>])/.exec(head);
  if (assignment) {
    const value = result.slice(assignment.index + 1);
    if (value.trim() === '' || LITERAL_START.test(value)) result = result.slice(0, assignment.index).trimEnd();
  }
  return result.replace(/(["'`])(?:\\.|(?!\1)[^\\]){9,}\1/g, '$1…$1');
}

export interface ResolvedSymbol {
  path: string;
  signature: string;
}

export function formatSymbols(symbols: readonly ResolvedSymbol[], charsPerToken: number, maxTokens: number = MAX_SYMBOL_TOKENS): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  let budget = maxTokens * charsPerToken;
  for (const symbol of symbols) {
    if (lines.length >= MAX_SYMBOLS) break;
    const signature = withoutStructuralTags(symbol.signature).trim();
    if (!signature || seen.has(signature)) continue;
    const line = `${signature}  // ${symbol.path}`;
    if (line.length > budget) continue;
    budget -= line.length + 1;
    seen.add(signature);
    lines.push(line);
  }
  return lines;
}
