export interface PromptLimits {
  /** Lines before the cursor, at most. */
  prefixLines: number;
  /** Lines after the cursor, at most. */
  suffixLines: number;
  prefixChars: number;
  suffixChars: number;
  /** Token budget for the file context (prefix + suffix). The prefix is trimmed from the top to fit. */
  fileTargetTokens: number;
  /** Ceiling for the whole user message; optional blocks are dropped before it is exceeded. */
  hardTokens: number;
  /** Calibrated characters per token, used for every estimate here. */
  charsPerToken: number;
}

export const DEFAULT_LIMITS: Omit<PromptLimits, 'fileTargetTokens' | 'charsPerToken'> = {
  prefixLines: 60,
  suffixLines: 20,
  prefixChars: 3000,
  suffixChars: 1000,
  hardTokens: 2500,
};

/** The suffix matters less than the prefix: it never takes more than this share of the file budget. */
const SUFFIX_SHARE = 0.25;
const MIN_PREFIX_CHARS = 400;

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
  /** Project style guide. Sent first and byte-identical between requests (the stable block). */
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

function render(input: PromptInput, prefix: string, suffix: string, examples: PromptExample[], symbols: string[]): string {
  const parts: string[] = [];
  const style = input.styleProfile?.trim();
  if (style) parts.push(`<style>\n${style}\n</style>\n`);
  if (examples.length > 0) {
    const body = examples
      .map((example) => `<example>\n<before>\n${example.before}\n</before>\n<accepted>${example.accepted}</accepted>\n</example>`)
      .join('\n');
    parts.push(`<examples>\n${body}\n</examples>\n`);
  }
  if (symbols.length > 0) parts.push(`<symbols>\n${symbols.join('\n')}\n</symbols>\n`);
  parts.push(
    `<file path="${attribute(input.path)}" language="${attribute(input.languageId)}">\n` +
      `<prefix>${prefix}</prefix><cursor/><suffix>${suffix}</suffix>\n</file>`,
  );
  return parts.join('\n');
}

/**
 * Builds the user message. Order is fixed: the stable block (style) first, then the variable blocks
 * (examples, symbols) and the file context last, right next to where the model starts answering.
 */
export function buildPrompt(input: PromptInput): BuiltPrompt {
  const { limits } = input;
  const charsPerToken = Math.max(1, limits.charsPerToken);
  const tokens = (chars: number): number => Math.ceil(chars / charsPerToken);

  const fileBudgetChars = Math.max(MIN_PREFIX_CHARS, Math.floor(limits.fileTargetTokens * charsPerToken));
  let suffix = takeSuffix(
    input.suffix,
    limits.suffixLines,
    Math.min(limits.suffixChars, Math.floor(fileBudgetChars * SUFFIX_SHARE)),
  );
  let prefix = takePrefix(
    input.prefix,
    limits.prefixLines,
    Math.min(limits.prefixChars, Math.max(MIN_PREFIX_CHARS, fileBudgetChars - suffix.length)),
  );
  let examples = [...(input.examples ?? [])];
  let symbols = [...(input.symbols ?? [])];
  let text = render(input, prefix, suffix, examples, symbols);

  // Hard limit: give up the optional context first, then the suffix, and only then more of the prefix.
  const fits = (): boolean => tokens(text.length) <= limits.hardTokens;
  while (!fits() && symbols.length > 0) {
    symbols = symbols.slice(0, -1);
    text = render(input, prefix, suffix, examples, symbols);
  }
  while (!fits() && examples.length > 0) {
    examples = examples.slice(0, -1);
    text = render(input, prefix, suffix, examples, symbols);
  }
  while (!fits() && suffix.length > 0) {
    suffix = takeSuffix(suffix, limits.suffixLines, Math.floor(suffix.length / 2));
    text = render(input, prefix, suffix, examples, symbols);
  }
  while (!fits() && prefix.length > 1) {
    const excess = text.length - Math.floor(limits.hardTokens * charsPerToken);
    prefix = takePrefix(prefix, limits.prefixLines, Math.max(1, prefix.length - Math.max(excess, 1)));
    text = render(input, prefix, suffix, examples, symbols);
  }

  return {
    text,
    chars: text.length,
    estimatedTokens: tokens(text.length),
    prefix,
    suffix,
    examplesUsed: examples.length,
    symbolsUsed: symbols.length,
  };
}
