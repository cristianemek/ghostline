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

function unclosedParens(text: string): number {
  let depth = 0;
  for (const char of text) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
  }
  return depth;
}

/**
 * The declaration that starts at `line`, on one line: enough to tell the model the name, parameters
 * and return type. A signature split over several lines is joined until its parentheses close.
 */
export function extractSignature(lines: readonly string[], line: number): string {
  let signature = (lines[line] ?? '').trim();
  let next = line + 1;
  while (unclosedParens(signature) > 0 && next < lines.length && next - line < MAX_SIGNATURE_LINES) {
    signature += ' ' + (lines[next] ?? '').trim();
    next++;
  }
  // The body is of no use here: keep what comes before it.
  signature = signature.replace(/\s*\{\s*$/, '').replace(/\s*=>\s*\{?\s*$/, ' =>').replace(/\s+/g, ' ').trim();
  return signature.length > MAX_SIGNATURE_CHARS ? signature.slice(0, MAX_SIGNATURE_CHARS - 1) + '…' : signature;
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
