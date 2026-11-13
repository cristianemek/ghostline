import { totalInputTokens, type Usage } from '../cli/streamParser';

export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

export interface DayStats {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  shown: number;
  accepted: number;
  errors: number;
  timeouts: number;
  cancelled: number;
  localHits: number;
  unconfirmedTokens: number;
  latencies: number[];
  inputSamples: number[];
  p50?: number;
  p95?: number;
  medianInput?: number;
}

export type RequestStatus = 'ok' | 'error' | 'timeout' | 'cancelled';

export interface RequestRecord {
  status: RequestStatus;
  usage: Usage;
  costUsd: number;
  totalMs: number;
  sample?: boolean;
}

const STORE_KEY = 'ghostline.usage.v1';
const SPEND_KEY = 'ghostline.spend.v1';
const SPEND_BUCKET_MS = 15 * 60_000;
const SPEND_KEEP_MS = 8 * 24 * 3600_000;
const FALLBACK_USD_PER_INPUT_TOKEN = 0.0045 / 1900;
const KEEP_DAYS = 30;
const MAX_SAMPLES_PER_DAY = 400;
const COUNTERS = [
  'requests',
  'inputTokens',
  'outputTokens',
  'thinkingTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
  'shown',
  'accepted',
  'errors',
  'timeouts',
  'cancelled',
  'localHits',
  'unconfirmedTokens',
] as const;

export function emptyDay(date: string): DayStats {
  return {
    date,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    shown: 0,
    accepted: 0,
    errors: 0,
    timeouts: 0,
    cancelled: 0,
    localHits: 0,
    unconfirmedTokens: 0,
    latencies: [],
    inputSamples: [],
  };
}

export function localDate(time: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
}

export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function totalTokens(day: DayStats): number {
  return day.inputTokens + day.cacheReadTokens + day.cacheWriteTokens + day.outputTokens;
}

export function acceptanceRate(day: DayStats): number | undefined {
  return day.shown > 0 ? day.accepted / day.shown : undefined;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function sanitizeDay(raw: unknown): DayStats | null {
  if (raw === null || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.date !== 'string') return null;
  const day = emptyDay(source.date);
  for (const key of COUNTERS) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) day[key] = value;
  }
  const numbers = (value: unknown): number[] =>
    Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
  day.latencies = numbers(source.latencies);
  day.inputSamples = numbers(source.inputSamples);
  for (const key of ['p50', 'p95', 'medianInput'] as const) {
    const value = source[key];
    if (typeof value === 'number') day[key] = value;
  }
  return day;
}

export class UsageTracker {
  private stored = new Map<string, DayStats>();
  private pending = new Map<string, DayStats>();
  private storedSpend = new Map<number, number>();
  private pendingSpend = new Map<number, number>();
  private dirty = false;

  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.reload();
  }

  recordRequest(record: RequestRecord): void {
    const day = this.pendingToday();
    day.requests++;
    day.inputTokens += record.usage.inputTokens;
    day.outputTokens += record.usage.outputTokens;
    day.thinkingTokens += record.usage.thinkingTokens;
    day.cacheReadTokens += record.usage.cacheReadTokens;
    day.cacheWriteTokens += record.usage.cacheWriteTokens;
    day.costUsd += record.costUsd;
    this.addSpend(record.costUsd);
    if (record.status === 'error') day.errors++;
    else if (record.status === 'timeout') day.timeouts++;
    else if (record.status === 'cancelled') day.cancelled++;
    else if (record.sample !== false) {
      day.latencies.push(Math.round(record.totalMs));
      day.inputSamples.push(totalInputTokens(record.usage));
    }
    this.dirty = true;
  }

  recordShown(): void {
    this.pendingToday().shown++;
    this.dirty = true;
  }

  recordAccepted(): void {
    this.pendingToday().accepted++;
    this.dirty = true;
  }

  recordUnconfirmed(estimatedInputTokens: number): void {
    const tokens = Math.max(0, Math.round(estimatedInputTokens));
    const day = this.today();
    const measuredTokens = day.inputTokens + day.cacheReadTokens + day.cacheWriteTokens;
    const usdPerToken = day.costUsd > 0 && measuredTokens > 0 ? day.costUsd / measuredTokens : FALLBACK_USD_PER_INPUT_TOKEN;
    this.pendingToday().unconfirmedTokens += tokens;
    this.addSpend(tokens * usdPerToken);
    this.dirty = true;
  }

  spentSince(sinceMs: number): number {
    let total = 0;
    for (const spend of [this.storedSpend, this.pendingSpend]) {
      for (const [start, usd] of spend) {
        if (start + SPEND_BUCKET_MS > sinceMs) total += usd;
      }
    }
    return total;
  }

  recordLocalHit(): void {
    this.pendingToday().localHits++;
    this.dirty = true;
  }

  today(): DayStats {
    return this.day(localDate(this.now()));
  }

  lastDays(count: number): DayStats[] {
    const days: DayStats[] = [];
    const cursor = this.now();
    for (let i = 0; i < count; i++) {
      days.push(this.day(localDate(cursor)));
      cursor.setDate(cursor.getDate() - 1);
    }
    return days;
  }

  latency(day: DayStats = this.today()): { p50?: number; p95?: number } {
    if (day.latencies.length === 0) return { p50: day.p50, p95: day.p95 };
    return { p50: percentile(day.latencies, 50), p95: percentile(day.latencies, 95) };
  }

  medianInputTokens(day: DayStats = this.today()): number | undefined {
    return day.inputSamples.length > 0 ? percentile(day.inputSamples, 50) : day.medianInput;
  }

  overDailyLimit(limit: number): boolean {
    return limit > 0 && this.today().requests >= limit;
  }

  async flush(): Promise<void> {
    if (!this.dirty) {
      this.reload();
      return;
    }
    this.reload();
    const merged = new Map(this.stored);
    for (const [date, delta] of this.pending) merged.set(date, mergeDay(merged.get(date) ?? emptyDay(date), delta));
    const today = localDate(this.now());
    const kept = [...merged.values()]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, KEEP_DAYS)
      .map((day) => (day.date === today ? day : compactDay(day)));
    const oldest = this.now().getTime() - SPEND_KEEP_MS;
    const spend = new Map([...this.storedSpend].filter(([start]) => start >= oldest));
    for (const [start, usd] of this.pendingSpend) spend.set(start, (spend.get(start) ?? 0) + usd);
    this.pending.clear();
    this.pendingSpend.clear();
    this.dirty = false;
    this.stored = new Map(kept.map((day) => [day.date, day]));
    this.storedSpend = spend;
    await this.store.update(STORE_KEY, kept);
    await this.store.update(SPEND_KEY, [...spend].sort((a, b) => a[0] - b[0]));
  }

  async reset(): Promise<void> {
    this.pending.clear();
    this.stored.clear();
    this.pendingSpend.clear();
    this.storedSpend.clear();
    this.dirty = false;
    await this.store.update(STORE_KEY, []);
    await this.store.update(SPEND_KEY, []);
  }

  private addSpend(usd: number): void {
    if (!(usd > 0)) return;
    const start = Math.floor(this.now().getTime() / SPEND_BUCKET_MS) * SPEND_BUCKET_MS;
    this.pendingSpend.set(start, (this.pendingSpend.get(start) ?? 0) + usd);
  }

  private day(date: string): DayStats {
    const stored = this.stored.get(date) ?? emptyDay(date);
    const delta = this.pending.get(date);
    return delta ? mergeDay(stored, delta) : stored;
  }

  private pendingToday(): DayStats {
    const date = localDate(this.now());
    let day = this.pending.get(date);
    if (!day) {
      day = emptyDay(date);
      this.pending.set(date, day);
    }
    return day;
  }

  private reload(): void {
    const raw = this.store.get<unknown>(STORE_KEY);
    this.stored = new Map();
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const day = sanitizeDay(item);
        if (day) this.stored.set(day.date, day);
      }
    }
    const spend = this.store.get<unknown>(SPEND_KEY);
    this.storedSpend = new Map();
    if (!Array.isArray(spend)) return;
    for (const item of spend) {
      if (!Array.isArray(item)) continue;
      const [start, usd] = item as unknown[];
      if (typeof start === 'number' && typeof usd === 'number' && Number.isFinite(start) && usd > 0) this.storedSpend.set(start, usd);
    }
  }
}

function mergeDay(base: DayStats, delta: DayStats): DayStats {
  const merged: DayStats = { ...base };
  for (const key of COUNTERS) merged[key] = base[key] + delta[key];
  merged.latencies = [...base.latencies, ...delta.latencies].slice(-MAX_SAMPLES_PER_DAY);
  merged.inputSamples = [...base.inputSamples, ...delta.inputSamples].slice(-MAX_SAMPLES_PER_DAY);
  return merged;
}

function compactDay(day: DayStats): DayStats {
  if (day.latencies.length === 0 && day.inputSamples.length === 0) return day;
  return {
    ...day,
    p50: percentile(day.latencies, 50) ?? day.p50,
    p95: percentile(day.latencies, 95) ?? day.p95,
    medianInput: percentile(day.inputSamples, 50) ?? day.medianInput,
    latencies: [],
    inputSamples: [],
  };
}
