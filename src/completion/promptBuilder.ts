export interface PromptLimits {
  /** Lines before the cursor, at most. */
  prefixLines: number;
  /** Lines after the cursor, at most. */
  suffixLines: number;
  prefixChars: number;
  suffixChars: number;
  /**
   * Token budget for the whole user message. Examples and symbols are paid for out of it (the prefix
   * is trimmed from the top to make room); the style profile only goes in when there is room to spare.
   */
  targetTokens: number;
  /** Ceiling for the whole user message; optional blocks are dropped before it is exceeded. */
  hardTokens: number;
  /** Calibrated characters per token, used for every estimate here. */
  charsPerToken: number;
}

export const DEFAULT_LIMITS: Omit<PromptLimits, 'targetTokens' | 'charsPerToken'> = {
  prefixLines: 60,
  suffixLines: 20,
  prefixChars: 3000,
  suffixChars: 1000,
  hardTokens: 2500,
};

/** The suffix matters less than the prefix: it never takes more than this share of the file budget. */
const SUFFIX_SHARE = 0.25;
const MIN_PREFIX_CHARS = 400;
/** Hints never crowd out the code itself: the file keeps at least this share of the budget. */
const MIN_FILE_SHARE = 0.6;

export interface PromptExample {
  /** The few lines that preceded an accepted completion. */
  before: string;
  /** What was accepted. */
  accepted: string;
}

export interface PromptInput {
  /** Workspace-relative path, only used as a hint for the model. */
  path: string;
  languageId: string;
  /** Text before the cursor. May be the whole document: it is windowed here. */
  prefix: string;
  /** Text after the cursor. */
  suffix: string;
  /** Project style guide. When sent it goes first and is byte-identical between requests (the stable block). */
  styleProfile?: string;
  examples?: PromptExample[];
  /** Signature lines of symbols used near the cursor. */
  symbols?: string[];
  limits: PromptLimits;
}

export interface BuiltPrompt {
  text: string;
  chars: number;
  estimatedTokens: number;
  /** The windows actually sent, needed again to post-process the answer. */
  prefix: string;
  suffix: string;
  styleUsed: boolean;
  examplesUsed: number;
  symbolsUsed: number;
}

/** Last `maxLines` lines of the prefix (the current line counts as one), within `maxChars`. */
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
    // Start on a line boundary, unless the current line alone is longer than the budget.
    if (window[cutAt - 1] === '\n' || firstNewline < 0) window = cut;
    else window = cut.slice(firstNewline + 1);
  }
  return window;
}

/** Rest of the current line plus the next `maxLines` lines, within `maxChars`. */
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
    // End on a line boundary when there is one.
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

function render(input: PromptInput, prefix: string, suffix: string, blocks: Blocks): string {
  return [
    ...hintBlocks(blocks),
    `<file path="${attribute(input.path)}" language="${attribute(input.languageId)}">\n` +
      `<prefix>${prefix}</prefix><cursor/><suffix>${suffix}</suffix>\n</file>`,
  ].join('\n');
}

/**
 * Builds the user message. Order is fixed: the stable block (style) first, then the variable blocks
 * (examples, symbols) and the file context last, right next to where the model starts answering.
 *
 * Budget (measured in docs/fase-2.md):
 * - the file context gets the whole target by default;
 * - the style profile is added only when the file leaves room for it. In a long file the surrounding
 *   code already shows the style, and trading real code for a generic guide made suggestions worse;
 * - examples and symbols are specific to the cursor, so they do take room from the top of the prefix,
 *   but never more than 40 % of the budget.
 */
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

  // Hard limit: give up the optional context first, then the suffix, and only then more of the prefix.
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
    styleUsed: blocks.style !== undefined,
    examplesUsed: blocks.examples.length,
    symbolsUsed: blocks.symbols.length,
  };
}
