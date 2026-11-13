export class FailureBreaker {
  private failures = 0;
  private openUntil = 0;
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

  failure(message: string): number {
    this.failures++;
    if (this.failures < this.threshold) return 0;
    const pause = Math.min(this.maxMs, this.baseMs * 2 ** (this.failures - this.threshold));
    this.openUntil = this.now() + pause;
    this.reason = message;
    return pause;
  }

  get remainingMs(): number {
    return Math.max(0, this.openUntil - this.now());
  }

  get open(): boolean {
    return this.remainingMs > 0;
  }
}
