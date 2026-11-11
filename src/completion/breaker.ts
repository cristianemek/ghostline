/**
 * Stops automatic requests after repeated failures. Without it, a CLI that cannot answer (not logged
 * in, subscription limit reached, no network) would be launched again at every pause in typing:
 * a process per attempt, an error line per attempt, and nothing to show for it.
 *
 * After `threshold` failures in a row the breaker opens for 30 s, doubling on each further failure
 * up to 10 minutes. Any success closes it. Manual requests are never blocked: they are how the user
 * (and the breaker) finds out that things work again.
 */
export class FailureBreaker {
  private failures = 0;
  private openUntil = 0;
  /** Why it is open: the message of the failure that opened it. */
  reason: string | undefined;

  constructor(
    private readonly threshold = 3,
    private readonly baseMs = 30_000,
    private readonly maxMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  success(): void {
    this.failures = 0;
    this.openUntil = 0;
    this.reason = undefined;
  }

  /** Records a failure. Returns how long automatic requests are now paused for (0 = not paused). */
  failure(message: string): number {
    this.failures++;
    if (this.failures < this.threshold) return 0;
    const pause = Math.min(this.maxMs, this.baseMs * 2 ** (this.failures - this.threshold));
    this.openUntil = this.now() + pause;
    this.reason = message;
    return pause;
  }

  /** Milliseconds left before automatic requests may resume; 0 when they may. */
  get remainingMs(): number {
    return Math.max(0, this.openUntil - this.now());
  }

  get open(): boolean {
    return this.remainingMs > 0;
  }
}
