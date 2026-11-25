import { cleanBlock } from '../completion/postprocess';
import { takePrefix, takeSuffix, withoutStructuralTags, type PromptLimits } from '../completion/promptBuilder';

export interface Problem {
  line: number;
  message: string;
}

export interface FixRegion {
  startLine: number;
  endLine: number;
}

export const PROBLEM_WINDOW_LINES = 6;
export const MAX_REGION_LINES = 12;
const WORK_IN_PROGRESS =
  /declared and not used|imported and not used|is declared but (?:its value is )?never (?:read|used)|is assigned a value but never used|is defined but never used|\bunused (?:variable|import|parameter|function|label)|never read|missing return/i;

export function isWorkInProgress(message: string): boolean {
  return WORK_IN_PROGRESS.test(message);
}

const MAX_PROBLEMS = 6;
const MAX_MESSAGE_CHARS = 160;
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

function problemText(message: string): string {
  const firstLine = message.split('\n')[0] ?? '';
  const withoutPaths = firstLine.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s'"`:()<>|\\/]+){2,}/g, (path) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1));
  return withoutStructuralTags(withoutPaths).slice(0, MAX_MESSAGE_CHARS);
}

export interface FixPromptInput {
  path: string;
  languageId: string;
  before: string;
  region: string;
  after: string;
  problems: readonly Problem[];
  regionStartLine: number;
  limits: PromptLimits;
}

export function buildFixPrompt(input: FixPromptInput): { text: string; chars: number } {
  const { limits } = input;
  const budget = Math.floor(limits.targetTokens * Math.max(1, limits.charsPerToken));
  const suffix = takeSuffix(input.after, limits.suffixLines, Math.min(limits.suffixChars, Math.floor(budget * 0.25)));
  const prefix = takePrefix(input.before, limits.prefixLines, Math.min(limits.prefixChars, Math.max(400, budget - suffix.length - input.region.length)));
  const seen = new Set<string>();
  const problems = input.problems
    .map((problem) => `- line ${problem.line - input.regionStartLine + 1}: ${problemText(problem.message)}`)
    .filter((line) => !seen.has(line) && seen.add(line))
    .slice(0, MAX_PROBLEMS);
  const attribute = (value: string): string => value.replace(/["\r\n]/g, ' ').trim();
  const count = input.region.split('\n').length;
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

export function parseFix(answer: string, original: readonly string[], languageId?: string): string[] | undefined {
  const text = cleanBlock(answer, languageId);
  if (!text) return undefined;
  let lines = text.split('\n');
  const wanted = leadingWhitespace(original.find((line) => line.trim() !== '') ?? '');
  const given = leadingWhitespace(lines.find((line) => line.trim() !== '') ?? '');
  if (wanted !== given && lines.every((line) => line.trim() === '' || line.startsWith(given))) {
    lines = lines.map((line) => (line.trim() === '' ? '' : wanted + line.slice(given.length)));
  }
  lines = lines.map((line) => line.replace(/\s+$/, ''));
  if (lines.length > original.length + MAX_GROWTH_LINES) return undefined;
  if (lines.reduce((depth, line) => depth + depthChange(line), 0) !== 0) return undefined;
  const start = (list: readonly string[]): string => (list.find((line) => line.trim() !== '') ?? '').trim().slice(0, 2);
  if (start(lines) !== start(original)) return undefined;
  const same = lines.length === original.length && lines.every((line, index) => line === (original[index] as string).replace(/\s+$/, ''));
  return same ? undefined : lines;
}

export interface Change {
  oldLines: string[];
  newLines: string[];
}

const CHANGE = /<change>\s*<old>([\s\S]*?)<\/old>\s*<new>([\s\S]*?)<\/new>/i;
const CHANGE_LINES_BEFORE = 40;
const CHANGE_LINES_AFTER = 20;

function blockLines(block: string): string[] {
  const text = block.replace(/\r\n?/g, '\n').replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');
  return text.trim() === '' ? [] : text.split('\n').map((line) => line.replace(/\s+$/, ''));
}

export function parseChange(answer: string): Change | undefined {
  const found = CHANGE.exec(answer);
  if (!found) return undefined;
  const oldLines = blockLines(found[1] ?? '');
  const newLines = blockLines(found[2] ?? '');
  if (oldLines.length === 0 || oldLines.length > MAX_REGION_LINES) return undefined;
  if (newLines.length > oldLines.length + MAX_GROWTH_LINES) return undefined;
  if (oldLines.join('\n') === newLines.join('\n')) return undefined;
  return { oldLines, newLines };
}

export function locateChange(lineAt: (line: number) => string, lineCount: number, cursorLine: number, oldLines: readonly string[]): FixRegion | undefined {
  const wanted = oldLines.map((line) => line.trim());
  if (wanted.join('').length < 3) return undefined;
  const last = Math.min(lineCount - wanted.length, cursorLine + CHANGE_LINES_AFTER);
  let best: FixRegion | undefined;
  let bestDistance = Infinity;
  for (let start = Math.max(0, cursorLine - CHANGE_LINES_BEFORE); start <= last; start++) {
    if (!wanted.every((line, offset) => lineAt(start + offset).trim() === line)) continue;
    const end = start + wanted.length - 1;
    const distance = cursorLine < start ? start - cursorLine : cursorLine > end ? cursorLine - end : 0;
    if (distance < bestDistance) {
      best = { startLine: start, endLine: end };
      bestDistance = distance;
    }
  }
  return best;
}

export function changedLines(current: readonly string[], change: Change): string[] | undefined {
  const indentOf = (lines: readonly string[]): string => leadingWhitespace(lines.find((line) => line.trim() !== '') ?? '');
  const wanted = indentOf(current);
  const given = indentOf(change.oldLines);
  const lines = change.newLines.map((line) => {
    if (line.trim() === '') return '';
    return (wanted !== given && line.startsWith(given) ? wanted + line.slice(given.length) : line).replace(/\s+$/, '');
  });
  const depth = (list: readonly string[]): number => list.reduce((sum, line) => sum + depthChange(line), 0);
  if (depth(lines) !== depth(current)) return undefined;
  const same = lines.length === current.length && lines.every((line, index) => line === (current[index] as string).replace(/\s+$/, ''));
  return same ? undefined : lines;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newLines: string[];
}

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

export interface Span {
  start: number;
  end: number;
  text: string;
}

const MAX_LINE_TOKENS = 160;
const MAX_SPANS = 4;

export function lineSpans(before: string, after: string): Span[] | undefined {
  const tokens = (line: string): string[] => line.match(/[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu) ?? [];
  const old = tokens(before);
  const next = tokens(after);
  if (old.length > MAX_LINE_TOKENS || next.length > MAX_LINE_TOKENS) return undefined;
  const offsets = [0];
  for (const token of old) offsets.push((offsets.at(-1) as number) + token.length);
  const hunks = diffLines(old, next);
  if (hunks.length === 0 || hunks.length > MAX_SPANS) return undefined;
  const spans = hunks.map((hunk) => ({
    start: offsets[hunk.oldStart] as number,
    end: offsets[hunk.oldStart + hunk.oldCount] as number,
    text: hunk.newLines.join(''),
  }));
  if (spans.some((span) => before.slice(span.start, span.end).trim() === '' && span.text.trim() === '')) return undefined;
  return spans;
}

const MAX_PREVIEW_CHARS = 160;

export function hunkPreview(hunk: Hunk): string {
  if (hunk.newLines.length === 0) return 'se elimina';
  const text = hunk.newLines.map((line) => line.trim()).join(' ⏎ ');
  return text.length > MAX_PREVIEW_CHARS ? `${text.slice(0, MAX_PREVIEW_CHARS - 1)}…` : text;
}
