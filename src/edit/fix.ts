import { cleanBlock } from '../completion/postprocess';
import { takePrefix, takeSuffix, type PromptLimits } from '../completion/promptBuilder';

/**
 * Corrections: code that is already written and that the compiler rejects, rewritten. Everything here
 * is pure; `editSuggester.ts` decides when to ask and shows the result.
 */

export interface Problem {
  /** 0-based line in the document. */
  line: number;
  message: string;
}

export interface FixRegion {
  /** Both inclusive, 0-based. */
  startLine: number;
  endLine: number;
}

/** How far from the cursor a problem still counts as "what the user is looking at". */
export const PROBLEM_WINDOW_LINES = 6;
/** A region longer than this is a rewrite of the function, not a correction. */
export const MAX_REGION_LINES = 12;
const MAX_PROBLEMS = 6;
const MAX_MESSAGE_CHARS = 160;
/** How many lines longer than the original a correction may be. */
const MAX_GROWTH_LINES = 8;

function depthChange(line: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index] as string;
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '/' && line[index + 1] === '/') break;
    else if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') depth--;
  }
  return depth;
}

/**
 * The lines to rewrite: from the first to the last problem near the cursor, extended downwards until
 * the brackets they open are closed, so that the region is a whole statement or block. Undefined when
 * there is nothing near the cursor, or when what would have to be rewritten is too long or cannot be
 * cut out cleanly.
 */
export function fixRegion(lineAt: (line: number) => string, lineCount: number, problems: readonly Problem[], cursorLine: number): FixRegion | undefined {
  const near = problems.filter((problem) => Math.abs(problem.line - cursorLine) <= PROBLEM_WINDOW_LINES && problem.line < lineCount);
  if (near.length === 0) return undefined;
  const startLine = Math.min(...near.map((problem) => problem.line));
  let endLine = Math.max(...near.map((problem) => problem.line));
  let depth = 0;
  for (let line = startLine; line <= endLine; line++) depth += depthChange(lineAt(line));
  while (depth > 0 && endLine < lineCount - 1 && endLine - startLine + 1 < MAX_REGION_LINES) {
    endLine++;
    depth += depthChange(lineAt(endLine));
  }
  if (depth !== 0 || endLine - startLine + 1 > MAX_REGION_LINES) return undefined;
  return { startLine, endLine };
}

export interface FixPromptInput {
  path: string;
  languageId: string;
  /** The document's text before the region's first line, the region itself, and what follows it. */
  before: string;
  region: string;
  after: string;
  /** Problems inside the region, with document line numbers. */
  problems: readonly Problem[];
  regionStartLine: number;
  limits: PromptLimits;
}

/**
 * The user message for a correction: the same file wrapper as a completion, with the region to
 * rewrite marked where the cursor would be, and what the compiler says about it.
 */
export function buildFixPrompt(input: FixPromptInput): { text: string; chars: number } {
  const { limits } = input;
  const budget = Math.floor(limits.targetTokens * Math.max(1, limits.charsPerToken));
  const suffix = takeSuffix(input.after, limits.suffixLines, Math.min(limits.suffixChars, Math.floor(budget * 0.25)));
  const prefix = takePrefix(input.before, limits.prefixLines, Math.min(limits.prefixChars, Math.max(400, budget - suffix.length - input.region.length)));
  const seen = new Set<string>();
  const problems = input.problems
    .map((problem) => `- line ${problem.line - input.regionStartLine + 1}: ${problem.message.split('\n')[0]?.slice(0, MAX_MESSAGE_CHARS) ?? ''}`)
    .filter((line) => !seen.has(line) && seen.add(line))
    .slice(0, MAX_PROBLEMS);
  const attribute = (value: string): string => value.replace(/["\r\n]/g, ' ').trim();
  const count = input.region.split('\n').length;
  // The last thing the model reads says what to output: without it, a small model answered as if it
  // were completing at a cursor (the missing arguments, half a line).
  const text =
    `<file path="${attribute(input.path)}" language="${attribute(input.languageId)}">\n` +
    `<prefix>${prefix}</prefix><region>\n${input.region}\n</region><suffix>${suffix}</suffix>\n</file>\n` +
    `<fix>\nThe compiler reports, inside <region>:\n${problems.join('\n')}\n</fix>\n` +
    `Write ${count === 1 ? 'the line' : `the ${count} lines`} of <region> again, from ${count === 1 ? 'its' : 'the first line\'s'} first character to the end, with these errors fixed.`;
  return { text, chars: text.length };
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/**
 * The model's answer as the new lines of the region, or undefined when it is not a correction: not
 * code, the same as what is there, or so much longer that it is something else.
 */
export function parseFix(answer: string, original: readonly string[], languageId?: string): string[] | undefined {
  const text = cleanBlock(answer, languageId);
  if (!text) return undefined;
  let lines = text.split('\n');
  // Same indentation as the code it replaces: the model sometimes answers from the left margin.
  const wanted = leadingWhitespace(original.find((line) => line.trim() !== '') ?? '');
  const given = leadingWhitespace(lines.find((line) => line.trim() !== '') ?? '');
  if (wanted !== given && lines.every((line) => line.trim() === '' || line.startsWith(given))) {
    lines = lines.map((line) => (line.trim() === '' ? '' : wanted + line.slice(given.length)));
  }
  lines = lines.map((line) => line.replace(/\s+$/, ''));
  if (lines.length > original.length + MAX_GROWTH_LINES) return undefined;
  // The region was cut out with its brackets balanced; a rewrite that is not would break what follows
  // ("switch {⏎case x:" with no closing brace, or the tail of a call: "ctx, id)").
  if (lines.reduce((depth, line) => depth + depthChange(line), 0) !== 0) return undefined;
  // A rewrite starts where the original starts. An answer that does not is a fragment of the line
  // (the model answering as if it were completing): "ListContextMessages(ctx, id)" for
  // "rows, err := c.queries.ListContextMessages(ctx, id, nil)". Two characters are enough to let a
  // corrected typo through ("retrun" → "return").
  const start = (list: readonly string[]): string => (list.find((line) => line.trim() !== '') ?? '').trim().slice(0, 2);
  if (start(lines) !== start(original)) return undefined;
  const same = lines.length === original.length && lines.every((line, index) => line === (original[index] as string).replace(/\s+$/, ''));
  return same ? undefined : lines;
}

/** One stretch of the region that changes: `oldCount` lines from `oldStart` become `newLines`. */
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newLines: string[];
}

/** Line diff between what is there and the correction, as the stretches that change (LCS; regions are a few lines). */
export function diffLines(oldLines: readonly string[], newLines: readonly string[]): Hunk[] {
  const rows = oldLines.length;
  const columns = newLines.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      (lcs[i] as number[])[j] =
        oldLines[i] === newLines[j] ? ((lcs[i + 1] as number[])[j + 1] as number) + 1 : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
    }
  }
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let i = 0;
  let j = 0;
  while (i < rows || j < columns) {
    if (i < rows && j < columns && oldLines[i] === newLines[j]) {
      current = undefined;
      i++;
      j++;
      continue;
    }
    if (!current) {
      current = { oldStart: i, oldCount: 0, newLines: [] };
      hunks.push(current);
    }
    const dropOld = j >= columns || (i < rows && ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number));
    if (dropOld) {
      current.oldCount++;
      i++;
    } else {
      current.newLines.push(newLines[j] as string);
      j++;
    }
  }
  return hunks;
}

const MAX_PREVIEW_CHARS = 160;

/** What is shown after the old text of a stretch: the new lines on one line, or a note that it goes away. */
export function hunkPreview(hunk: Hunk): string {
  if (hunk.newLines.length === 0) return 'se elimina';
  const text = hunk.newLines.map((line) => line.trim()).join(' ⏎ ');
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS - 1)}…` : text;
}
