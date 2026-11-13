const ONLY_CLOSERS_AFTER_CURSOR = /^[\s)\]}"'`;]*$/;

export function cursorAllowsAuto(restOfLine: string): boolean {
  return ONLY_CLOSERS_AFTER_CURSOR.test(restOfLine);
}

const WORD_CHAR = /[A-Za-z0-9_$]/;
const MAX_TYPED_CHARS = 2;

export function typedInsertionEnd(
  changes: readonly { rangeOffset: number; rangeLength: number; text: string }[],
): number | undefined {
  const change = changes.length === 1 ? changes[0] : undefined;
  if (!change || change.rangeLength !== 0 || change.text.length === 0 || change.text.length > MAX_TYPED_CHARS) return undefined;
  return change.rangeOffset + change.text.length;
}

export function midLineAllowsAuto(linePrefix: string, restOfLine: string): boolean {
  if (linePrefix.trim() === '' || restOfLine.trim() === '') return false;
  const before = linePrefix.at(-1) ?? '';
  const after = restOfLine[0] ?? '';
  if (WORD_CHAR.test(before) && WORD_CHAR.test(after)) return false;
  if ((linePrefix.match(/["'`]/g)?.length ?? 0) % 2 === 1) return false;
  return !/\/\/|\/\*|^\s*(?:#|\*|--)/.test(linePrefix);
}

export type TriggerContext = 'after-dot' | 'after-paren' | 'new-line' | 'end-of-line' | 'mid-line';

export function classifyContext(linePrefix: string, restOfLine = ''): TriggerContext {
  if (linePrefix.trim() !== '' && !cursorAllowsAuto(restOfLine)) return 'mid-line';
  const trimmed = linePrefix.trimEnd();
  if (trimmed.trim() === '') return 'new-line';
  if (trimmed.endsWith('.')) return 'after-dot';
  if (trimmed.endsWith('(')) return 'after-paren';
  return 'end-of-line';
}

export function agreesWithTyping(answerSoFar: string, typed: string, lineWasBlank: boolean): boolean {
  let answer = answerSoFar.replace(/\r\n?/g, '\n');
  if (lineWasBlank) answer = answer.replace(/^\s+/, '');
  if (answer.startsWith('`')) return true;
  const length = Math.min(answer.length, typed.length);
  return answer.slice(0, length) === typed.slice(0, length);
}

const WINDOW_MS = 2000;
const FAST_KEYS_PER_SECOND = 6;

export class TypingRate {
  private stamps: number[] = [];

  record(now: number): void {
    this.stamps.push(now);
    this.prune(now);
  }

  isFast(now: number): boolean {
    this.prune(now);
    return this.stamps.length > FAST_KEYS_PER_SECOND * (WINDOW_MS / 1000);
  }

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

export function debounceDelay(debounceMs: number, typingFast: boolean): number {
  return typingFast ? debounceMs + FAST_TYPING_EXTRA_MS : debounceMs;
}

const PAUSE_FACTOR = 1.6;

export function eagerDelay(debounceMs: number, eagerDebounceMs: number, medianGapMs: number | undefined): number {
  const eager = medianGapMs === undefined ? eagerDebounceMs : Math.max(eagerDebounceMs, Math.round(medianGapMs * PAUSE_FACTOR));
  return Math.min(debounceMs, eager);
}

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
