/**
 * Learns, from the usage the CLI reports, how many input tokens a prompt of N characters really costs:
 *
 *   input tokens ≈ overhead + characters / charsPerToken
 *
 * The defaults were measured with claude-haiku-5-5 on TypeScript (docs/paso-0.md, docs/fase-1.md):
 * the CLI adds ~600 tokens to every request, the system prompt and the prompt wrapper ~400 more, and
 * code tokenizes at 2.4-2.9 characters per token (not the 3.5 one would guess). Other languages and
 * models differ, so the estimate keeps adjusting itself with an exponentially weighted least-squares fit.
 */
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
/** The slope is only trusted when prompt sizes actually varied (standard deviation in characters). */
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

  constructor(saved?: unknown) {
    this.state = isState(saved) ? { ...saved } : { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0 };
  }

  /** Feed one finished request: prompt size in characters and the input tokens the CLI reported. */
  observe(promptChars: number, inputTokens: number): void {
    if (!(promptChars > 0) || !(inputTokens > 0)) return;
    const s = this.state;
    // A request far from what is expected (the CLI retried, a different model answered…) would tilt
    // the fit for a long time: skip it once there is a baseline to compare against.
    if (s.n >= MIN_SAMPLES_FOR_OUTLIERS) {
      const ratio = inputTokens / this.estimateTotal(promptChars);
      if (ratio > OUTLIER_FACTOR || ratio < 1 / OUTLIER_FACTOR) return;
    }
    this.state = {
      n: s.n * DECAY + 1,
      sx: s.sx * DECAY + promptChars,
      sy: s.sy * DECAY + inputTokens,
      sxx: s.sxx * DECAY + promptChars * promptChars,
      sxy: s.sxy * DECAY + promptChars * inputTokens,
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

  /** Tokens every request costs before a single character of the prompt: CLI scaffolding + system prompt. */
  get overheadTokens(): number {
    const { n, sx, sy } = this.state;
    if (n < MIN_SAMPLES_FOR_OVERHEAD) return DEFAULT_OVERHEAD_TOKENS;
    return clamp(sy / n - sx / n / this.charsPerToken, OVERHEAD_RANGE);
  }

  /** Expected total input tokens for a prompt of this many characters. */
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
