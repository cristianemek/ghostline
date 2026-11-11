import { identifiers } from '../learning/similarity';

/** Pure helpers for Phase 3 (symbol context through the language server). */

export const MAX_SYMBOLS = 3;
/** The spec's ceiling for the whole block. */
export const MAX_SYMBOL_TOKENS = 400;
const MAX_SIGNATURE_CHARS = 240;
const MAX_SIGNATURE_LINES = 4;
const MIN_IDENTIFIER_LENGTH = 3;

export interface IdentifierUse {
  name: string;
  /** Column where the identifier starts on the line. */
  character: number;
}

/**
 * Up to three identifiers of the line worth looking up: the ones closest to the cursor, without
 * keywords, short names or repeats.
 */
export function pickIdentifiers(linePrefix: string, max: number = MAX_SYMBOLS): IdentifierUse[] {
  // `identifiers` applies the keyword and length rules; it lower-cases, so compare that way.
  const meaningful = identifiers(linePrefix);
  const picked: IdentifierUse[] = [];
  const seen = new Set<string>();
  const matches = [...linePrefix.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)].reverse();
  for (const match of matches) {
    if (picked.length >= max) break;
    const name = match[0];
    if (name.length < MIN_IDENTIFIER_LENGTH || !meaningful.has(name.toLowerCase()) || seen.has(name)) continue;
    // A word inside a string or after a comment marker is prose, not a symbol.
    const before = linePrefix.slice(0, match.index);
    if (/\/\/|#(?!\w)/.test(before) || ((before.match(/["'`]/g)?.length ?? 0) % 2 === 1)) continue;
    seen.add(name);
    picked.push({ name, character: match.index ?? 0 });
  }
  return picked;
}

/**
 * The bracket the cursor is inside of when it was opened on an earlier line: the call or the literal
 * being filled in ("…CreateParams{" three lines up). `above` holds the lines before the cursor's line,
 * nearest last. Undefined when it was opened on the cursor's own line (its identifiers are picked
 * anyway), when none is found, or when the brace opens a block of code rather than a value.
 */
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
    // "Params{", "foo({", "x = {", "return {" hold a value; "if (ok) {", "class Foo {", "=> {" hold code.
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
/** A declaration whose members are the whole point of looking it up, opening its body on that line. */
const TYPE_HEADS = [
  // Go: type Params struct {
  /^type\s+[\w$]+(?:\[[^\]]*\])?\s+(?:struct|interface)\s*\{$/,
  // TypeScript: type Filters = {
  /^type\s+[\w$]+(?:<[^{}]*>)?\s*=\s*\{$/,
  // TypeScript, Rust, Swift, Kotlin, the C family: interface Order {, pub struct Point {, enum Color {
  /^(?:const\s+)?(?:interface|struct|enum|trait|union)\s+[\w$]+[^{}=;()]*\{$/,
];

function opensTypeBody(line: string): boolean {
  const bare = line.trim().replace(MODIFIERS, '');
  return TYPE_HEADS.some((pattern) => pattern.test(bare));
}

/**
 * The members of a type whose body starts at `start`, one entry per member: names and types, never
 * values. Nested bodies are folded to "{…}". `complete` is false when the body was cut short.
 */
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
      // Go struct tags, the separator, and anything assigned (an enum value, a default).
      .replace(/\s*`[^`]*`\s*$/, '')
      .replace(/[,;]\s*$/, '')
      .replace(/\s*(?<![=!<>])=(?!>).*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (member) members.push(member);
  }
  return { members, complete: false };
}

/**
 * The declaration that starts at `line`, on one line: enough to tell the model the name, parameters
 * and return type. A signature split over several lines is joined until its parentheses close. For a
 * struct, interface, object type or enum the members are included too (`members: false` keeps it to
 * the head): the fields of a type are what a literal or a call being written needs.
 */
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
  // The body is of no use here: keep what comes before it.
  signature = signature.replace(/\s*\{\s*$/, '').replace(/\s*=>\s*\{?\s*$/, ' =>').replace(/\s+/g, ' ').trim();
  signature = withoutValues(signature);
  return signature.length > MAX_SIGNATURE_CHARS ? signature.slice(0, MAX_SIGNATURE_CHARS - 1) + '…' : signature;
}

const LITERAL_START = /^\s*(["'`\d[{-]|(?:true|false|null|none|nil|undefined)\b)/i;

/**
 * A declaration is sent for its shape, never for its contents: `const API_KEY = "sk-…"` in a file
 * that no exclusion pattern covers must not travel as a "signature". Literal initialisers are
 * dropped and any long string literal that remains (a default argument, say) is blanked.
 */
function withoutValues(signature: string): string {
  let result = signature;
  const paren = result.indexOf('(');
  const head = paren < 0 ? result : result.slice(0, paren);
  // The first plain "=" before any parenthesis: an assignment, not ==, =>, <=, >= or !=.
  const assignment = /(?<![=!<>])=(?![=>])/.exec(head);
  if (assignment) {
    const value = result.slice(assignment.index + 1);
    if (value.trim() === '' || LITERAL_START.test(value)) result = result.slice(0, assignment.index).trimEnd();
  }
  return result.replace(/(["'`])(?:\\.|(?!\1)[^\\]){9,}\1/g, '$1…$1');
}

export interface ResolvedSymbol {
  /** Workspace-relative path of the file that defines it. */
  path: string;
  signature: string;
}

/** One line per symbol, within the token budget. */
export function formatSymbols(symbols: readonly ResolvedSymbol[], charsPerToken: number, maxTokens: number = MAX_SYMBOL_TOKENS): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  let budget = maxTokens * charsPerToken;
  for (const symbol of symbols) {
    if (lines.length >= MAX_SYMBOLS) break;
    const signature = symbol.signature.trim();
    if (!signature || seen.has(signature)) continue;
    const line = `${signature}  // ${symbol.path}`;
    if (line.length > budget) continue;
    budget -= line.length + 1;
    seen.add(signature);
    lines.push(line);
  }
  return lines;
}
