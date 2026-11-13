export interface PromptLimits {
  prefixLines: number;
  suffixLines: number;
  prefixChars: number;
  suffixChars: number;
  targetTokens: number;
  hardTokens: number;
  charsPerToken: number;
}

export const DEFAULT_LIMITS: Omit<PromptLimits, 'targetTokens' | 'charsPerToken'> = {
  prefixLines: 60,
  suffixLines: 20,
  prefixChars: 3000,
  suffixChars: 1000,
  hardTokens: 2500,
};

const TAG_NAMES = 'project|style|examples?|before|accepted|symbols|file|prefix|suffix|cursor|line|fix|region';
const STRUCTURAL_TAG = new RegExp(`<\\/\\s*(?:${TAG_NAMES})\\s*>|<(?:${TAG_NAMES})(?:\\s[^>]*|\\s*\\/)>`, 'gi');
const BARE_OPENING_TAG = new RegExp(`<(?:${TAG_NAMES})>`, 'g');

// file contents must not be able to forge the prompt's own tags
export function withoutStructuralTags(text: string): string {
  return text.replace(STRUCTURAL_TAG, '').replace(BARE_OPENING_TAG, '');
}

const SUFFIX_SHARE = 0.25;
const MIN_PREFIX_CHARS = 400;
const MIN_FILE_SHARE = 0.6;

export interface PromptExample {
  before: string;
  accepted: string;
}

export interface PromptInput {
  path: string;
  languageId: string;
  prefix: string;
  suffix: string;
  styleProfile?: string;
  examples?: PromptExample[];
  symbols?: string[];
  limits: PromptLimits;
}

export interface BuiltPrompt {
  text: string;
  chars: number;
  estimatedTokens: number;
  prefix: string;
  suffix: string;
  line?: CursorLine;
  styleUsed: boolean;
  examplesUsed: number;
  symbolsUsed: number;
}

export function takePrefix(prefix: string, maxLines: number, maxChars: number): string {
  let start = prefix.length;
  for (let lines = 0; lines < maxLines; lines++) {
    const newline = prefix.lastIndexOf('\n', start - 1);
    if (newline < 0) {
      start = 0;
      break;
    }
    start = newline;
  }
  let window = prefix.slice(start === 0 ? 0 : start + 1);
  if (window.length > maxChars) {
    const cutAt = window.length - maxChars;
    const cut = window.slice(cutAt);
    const firstNewline = cut.indexOf('\n');
    if (window[cutAt - 1] === '\n' || firstNewline < 0) window = cut;
    else window = cut.slice(firstNewline + 1);
  }
  return window;
}

export function takeSuffix(suffix: string, maxLines: number, maxChars: number): string {
  let end = -1;
  for (let lines = 0; lines <= maxLines; lines++) {
    const newline = suffix.indexOf('\n', end + 1);
    if (newline < 0) {
      end = suffix.length;
      break;
    }
    end = newline;
  }
  let window = suffix.slice(0, end);
  if (window.length > maxChars) {
    const cut = window.slice(0, maxChars);
    const lastNewline = cut.lastIndexOf('\n');
    if (window[maxChars] === '\n' || lastNewline < 0) window = cut;
    else window = cut.slice(0, lastNewline);
  }
  return window;
}

function attribute(value: string): string {
  return value.replace(/["\r\n]/g, ' ').trim();
}

interface Blocks {
  style: string | undefined;
  examples: PromptExample[];
  symbols: string[];
}

function styleBlock(style: string): string {
  return `<style>\n${style}\n</style>\n`;
}

function hintBlocks(blocks: Blocks): string[] {
  const parts: string[] = [];
  if (blocks.style) parts.push(styleBlock(blocks.style));
  if (blocks.examples.length > 0) {
    const body = blocks.examples
      .map((example) => `<example>\n<before>\n${example.before}\n</before>\n<accepted>${example.accepted}</accepted>\n</example>`)
      .join('\n');
    parts.push(`<examples>\n${body}\n</examples>\n`);
  }
  if (blocks.symbols.length > 0) parts.push(`<symbols>\n${blocks.symbols.join('\n')}\n</symbols>\n`);
  return parts;
}

const ONLY_CLOSERS = /^[\s)\]}"'`;,]*$/;
const MAX_LINE_SIDE_CHARS = 300;

export interface CursorLine {
  before: string;
  after: string;
}

export function cursorLine(prefix: string, suffix: string): CursorLine | undefined {
  const newline = suffix.indexOf('\n');
  const after = newline < 0 ? suffix : suffix.slice(0, newline);
  const before = prefix.slice(prefix.lastIndexOf('\n') + 1).trimStart();
  if (ONLY_CLOSERS.test(after) || before === '') return undefined;
  if (before.length > MAX_LINE_SIDE_CHARS || after.length > MAX_LINE_SIDE_CHARS) return undefined;
  return { before, after };
}

function render(input: PromptInput, prefix: string, suffix: string, blocks: Blocks): string {
  const line = cursorLine(prefix, suffix);
  return [
    ...hintBlocks(blocks),
    `<file path="${attribute(input.path)}" language="${attribute(input.languageId)}">\n` +
      `<prefix>${prefix}</prefix><cursor/><suffix>${suffix}</suffix>\n</file>` +
      (line ? `\n<line>${line.before}▮${line.after}</line>` : ''),
  ].join('\n');
}

export function buildPrompt(input: PromptInput): BuiltPrompt {
  const { limits } = input;
  const charsPerToken = Math.max(1, limits.charsPerToken);
  const tokens = (chars: number): number => Math.ceil(chars / charsPerToken);
  const budgetChars = Math.floor(limits.targetTokens * charsPerToken);

  let suffix = takeSuffix(input.suffix, limits.suffixLines, Math.min(limits.suffixChars, Math.floor(budgetChars * SUFFIX_SHARE)));
  let prefix = takePrefix(
    input.prefix,
    limits.prefixLines,
    Math.min(limits.prefixChars, Math.max(MIN_PREFIX_CHARS, budgetChars - suffix.length)),
  );

  const style = input.styleProfile?.trim() || undefined;
  const blocks: Blocks = {
    style: style && prefix.length + suffix.length + styleBlock(style).length <= budgetChars ? style : undefined,
    examples: [...(input.examples ?? [])],
    symbols: [...(input.symbols ?? [])],
  };

  const specificChars = hintBlocks({ ...blocks, style: undefined }).join('\n').length;
  if (specificChars > 0) {
    const styleChars = blocks.style ? styleBlock(blocks.style).length : 0;
    const fileBudget = Math.max(MIN_PREFIX_CHARS, Math.floor(budgetChars * MIN_FILE_SHARE), budgetChars - specificChars - styleChars);
    if (prefix.length + suffix.length > fileBudget) {
      prefix = takePrefix(prefix, limits.prefixLines, Math.max(MIN_PREFIX_CHARS, fileBudget - suffix.length));
    }
  }
  let text = render(input, prefix, suffix, blocks);

  const fits = (): boolean => tokens(text.length) <= limits.hardTokens;
  const rerender = (): void => {
    text = render(input, prefix, suffix, blocks);
  };
  while (!fits() && blocks.symbols.length > 0) {
    blocks.symbols = blocks.symbols.slice(0, -1);
    rerender();
  }
  while (!fits() && blocks.examples.length > 0) {
    blocks.examples = blocks.examples.slice(0, -1);
    rerender();
  }
  if (!fits() && blocks.style) {
    blocks.style = undefined;
    rerender();
  }
  while (!fits() && suffix.length > 0) {
    suffix = takeSuffix(suffix, limits.suffixLines, Math.floor(suffix.length / 2));
    rerender();
  }
  while (!fits() && prefix.length > 1) {
    const excess = text.length - Math.floor(limits.hardTokens * charsPerToken);
    prefix = takePrefix(prefix, limits.prefixLines, Math.max(1, prefix.length - Math.max(excess, 1)));
    rerender();
  }

  return {
    text,
    chars: text.length,
    estimatedTokens: tokens(text.length),
    prefix,
    suffix,
    line: cursorLine(prefix, suffix),
    styleUsed: blocks.style !== undefined,
    examplesUsed: blocks.examples.length,
    symbolsUsed: blocks.symbols.length,
  };
}
