/** Auto mode only fires when nothing but whitespace or closing characters follows the cursor. */
const ONLY_CLOSERS_AFTER_CURSOR = /^[\s)\]}"'`;]*$/;

export function cursorAllowsAuto(restOfLine: string): boolean {
  return ONLY_CLOSERS_AFTER_CURSOR.test(restOfLine);
}

const WORD_CHAR = /[A-Za-z0-9_$]/;
/** Longest edit still taken for typing by hand (a character, or a pair the editor closed for you). */
const MAX_TYPED_CHARS = 2;

/**
 * Where a hand-typed insertion ended, as a document offset. Undefined for anything else: a deletion,
 * a replacement, a paste, an accepted suggestion or a multi-cursor edit.
 */
export function typedInsertionEnd(
  changes: readonly { rangeOffset: number; rangeLength: number; text: string }[],
): number | undefined {
  const change = changes.length === 1 ? changes[0] : undefined;
  if (!change || change.rangeLength !== 0 || change.text.length === 0 || change.text.length > MAX_TYPED_CHARS) return undefined;
  return change.rangeOffset + change.text.length;
}

/**
 * Auto mode with code after the cursor on the same line ("conversation, |c.queries.Create(…)"): worth
 * a request only where an insertion makes sense. Not on a line with nothing typed before the cursor,
 * not in the middle of a word, and not inside a string or a comment, where it is text being edited.
 * The caller also requires that the user has just typed right there.
 */
export function midLineAllowsAuto(linePrefix: string, restOfLine: string): boolean {
  if (linePrefix.trim() === '' || restOfLine.trim() === '') return false;
  const before = linePrefix.at(-1) ?? '';
  const after = restOfLine[0] ?? '';
  if (WORD_CHAR.test(before) && WORD_CHAR.test(after)) return false;
  if ((linePrefix.match(/["'`]/g)?.length ?? 0) % 2 === 1) return false;
  return !/\/\/|\/\*|^\s*(?:#|\*|--)/.test(linePrefix);
}

/** Where the cursor is, for the adaptive trigger's acceptance statistics. */
export type TriggerContext = 'after-dot' | 'after-paren' | 'new-line' | 'end-of-line' | 'mid-line';

export function classifyContext(linePrefix: string, restOfLine = ''): TriggerContext {
  // Code after the cursor is a different situation whatever comes before it.
  if (linePrefix.trim() !== '' && !cursorAllowsAuto(restOfLine)) return 'mid-line';
  const trimmed = linePrefix.trimEnd();
  if (trimmed.trim() === '') return 'new-line';
  if (trimmed.endsWith('.')) return 'after-dot';
  if (trimmed.endsWith('(')) return 'after-paren';
  return 'end-of-line';
}

/**
 * Whether what the user typed since a request was sent still agrees with what that request has
 * answered so far: as far as both go, they are the same text. While that holds, the request in the
 * air is worth more than a new one.
 */
export function agreesWithTyping(answerSoFar: string, typed: string, lineWasBlank: boolean): boolean {
  let answer = answerSoFar.replace(/\r\n?/g, '\n');
  // On a blank line the leading whitespace of the answer is dropped when it is shown.
  if (lineWasBlank) answer = answer.replace(/^\s+/, '');
  // A code fence or backtick wrapper cannot be judged until the whole answer is in.
  if (answer.startsWith('`')) return true;
  const length = Math.min(answer.length, typed.length);
  return answer.slice(0, length) === typed.slice(0, length);
}

const WINDOW_MS = 2000;
const FAST_KEYS_PER_SECOND = 6;

/** Tracks keystrokes to tell "typing in flow" from "paused to think". */
export class TypingRate {
  private stamps: number[] = [];

  record(now: number): void {
    this.stamps.push(now);
    this.prune(now);
  }

  /** More than 6 keystrokes per second over the last 2 seconds. */
  isFast(now: number): boolean {
    this.prune(now);
    return this.stamps.length > FAST_KEYS_PER_SECOND * (WINDOW_MS / 1000);
  }

  /**
   * The user's current rhythm: median gap between recent keystrokes, in ms. Undefined when there are
   * too few to tell (the cursor was just placed, or the user has been idle).
   */
  medianGap(now: number): number | undefined {
    this.prune(now);
    if (this.stamps.length < 5) return undefined;
    const gaps: number[] = [];
    for (let i = 1; i < this.stamps.length; i++) gaps.push((this.stamps[i] as number) - (this.stamps[i - 1] as number));
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    let drop = 0;
    while (drop < this.stamps.length && (this.stamps[drop] as number) < cutoff) drop++;
    if (drop > 0) this.stamps = this.stamps.slice(drop);
  }
}

const FAST_TYPING_EXTRA_MS = 400;

/** How long to wait after the last keystroke before asking for a suggestion. */
export function debounceDelay(debounceMs: number, typingFast: boolean): number {
  // Someone typing fast who pauses briefly is most likely about to continue: wait longer before
  // spending a request on them.
  return typingFast ? debounceMs + FAST_TYPING_EXTRA_MS : debounceMs;
}

/** A gap this many times the user's usual one between keystrokes is a pause, not typing. */
const PAUSE_FACTOR = 1.6;

/**
 * The wait at a trigger point: short, but never shorter than what tells a pause from this user's own
 * typing rhythm. Someone typing a key every 110 ms has paused after ~180 ms; a slower typist has
 * not, and a fixed short wait would fire a request after almost every word.
 */
export function eagerDelay(debounceMs: number, eagerDebounceMs: number, medianGapMs: number | undefined): number {
  const eager = medianGapMs === undefined ? eagerDebounceMs : Math.max(eagerDebounceMs, Math.round(medianGapMs * PAUSE_FACTOR));
  return Math.min(debounceMs, eager);
}

/** Resolves after `ms`, or earlier with `false` when the signal aborts. */
export function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
