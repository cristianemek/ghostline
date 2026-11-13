export interface CalibrationState {
  n: number;
  sx: number;
  sy: number;
  sxx: number;
  sxy: number;
}

export const DEFAULT_CHARS_PER_TOKEN = 2.7;
export const DEFAULT_OVERHEAD_TOKENS = 1000;

const DECAY = 0.98;
const MIN_SAMPLES_FOR_OVERHEAD = 3;
const MIN_SAMPLES_FOR_SLOPE = 8;
const MIN_SAMPLES_FOR_OUTLIERS = 5;
const OUTLIER_FACTOR = 1.5;
const MAX_REJECTED_IN_A_ROW = 8;
const MIN_SPREAD_CHARS = 300;
const CHARS_PER_TOKEN_RANGE: readonly [number, number] = [1.5, 5];
const OVERHEAD_RANGE: readonly [number, number] = [300, 3000];

function clamp(value: number, [min, max]: readonly [number, number]): number {
  return Math.min(max, Math.max(min, value));
}

function isState(value: unknown): value is CalibrationState {
  if (value === null || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return ['n', 'sx', 'sy', 'sxx', 'sxy'].every((key) => typeof state[key] === 'number' && Number.isFinite(state[key]));
}

export class TokenEstimator {
  private state: CalibrationState;
  private rejectedInARow = 0;

  constructor(saved?: unknown) {
    this.state = isState(saved) ? { ...saved } : { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0 };
  }

  observe(promptChars: number, inputTokens: number): void {
    if (!(promptChars > 0) || !(inputTokens > 0)) return;
    const s = this.state;
    let base = s;
    if (s.n >= MIN_SAMPLES_FOR_OUTLIERS) {
      const ratio = inputTokens / this.estimateTotal(promptChars);
      if (ratio > OUTLIER_FACTOR || ratio < 1 / OUTLIER_FACTOR) {
        this.rejectedInARow++;
        if (this.rejectedInARow < MAX_REJECTED_IN_A_ROW) return;
        base = { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0 };
      }
    }
    this.rejectedInARow = 0;
    this.state = {
      n: base.n * DECAY + 1,
      sx: base.sx * DECAY + promptChars,
      sy: base.sy * DECAY + inputTokens,
      sxx: base.sxx * DECAY + promptChars * promptChars,
      sxy: base.sxy * DECAY + promptChars * inputTokens,
    };
  }

  get charsPerToken(): number {
    const { n, sx, sy, sxx, sxy } = this.state;
    if (n < MIN_SAMPLES_FOR_SLOPE) return DEFAULT_CHARS_PER_TOKEN;
    const variance = sxx / n - (sx / n) ** 2;
    if (variance < MIN_SPREAD_CHARS ** 2) return DEFAULT_CHARS_PER_TOKEN;
    const tokensPerChar = (sxy / n - (sx / n) * (sy / n)) / variance;
    if (!(tokensPerChar > 0)) return DEFAULT_CHARS_PER_TOKEN;
    return clamp(1 / tokensPerChar, CHARS_PER_TOKEN_RANGE);
  }

  get overheadTokens(): number {
    const { n, sx, sy } = this.state;
    if (n < MIN_SAMPLES_FOR_OVERHEAD) return DEFAULT_OVERHEAD_TOKENS;
    return clamp(sy / n - sx / n / this.charsPerToken, OVERHEAD_RANGE);
  }

  estimateTotal(promptChars: number): number {
    return Math.round(this.overheadTokens + promptChars / this.charsPerToken);
  }

  get samples(): number {
    return this.state.n;
  }

  toJSON(): CalibrationState {
    return { ...this.state };
  }
}
