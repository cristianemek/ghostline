/** Auto mode only fires when nothing but whitespace or closing characters follows the cursor. */
const ONLY_CLOSERS_AFTER_CURSOR = /^[\s)\]}"'`;]*$/;

export function cursorAllowsAuto(restOfLine: string): boolean {
  return ONLY_CLOSERS_AFTER_CURSOR.test(restOfLine);
}

/** Where the cursor is, for the adaptive trigger's acceptance statistics. */
export type TriggerContext = 'after-dot' | 'after-paren' | 'new-line' | 'end-of-line';

export function classifyContext(linePrefix: string): TriggerContext {
  const trimmed = linePrefix.trimEnd();
  if (trimmed.trim() === '') return 'new-line';
  if (trimmed.endsWith('.')) return 'after-dot';
  if (trimmed.endsWith('(')) return 'after-paren';
  return 'end-of-line';
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
