import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Usage } from '../../src/cli/streamParser';
import {
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_OVERHEAD_TOKENS,
  TokenEstimator,
} from '../../src/usage/tokenEstimator';
import {
  UsageTracker,
  acceptanceRate,
  formatTokens,
  localDate,
  percentile,
  totalTokens,
  type KeyValueStore,
} from '../../src/usage/usageTracker';

function memoryStore(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    update: (key, value) => {
      data.set(key, structuredClone(value));
    },
  };
}

function usage(input: number, output = 10, extra: Partial<Usage> = {}): Usage {
  return { inputTokens: input, outputTokens: output, thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...extra };
}

function clock(start: string): { now: () => Date; set: (iso: string) => void } {
  let current = new Date(start);
  return { now: () => new Date(current), set: (iso) => (current = new Date(iso)) };
}

test('percentile uses nearest rank', () => {
  assert.equal(percentile([], 50), undefined);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([4, 1, 3, 2, 5], 50), 3);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(hundred, 95), 95);
  assert.equal(percentile(hundred, 100), 100);
});

test('formatTokens', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(180_400), '180k');
  assert.equal(formatTokens(2_300_000), '2.3M');
});

test('tracker: counts requests, tokens, outcomes and latencies per day', () => {
  const time = clock('2026-11-11T10:00:00');
  const tracker = new UsageTracker(memoryStore(), time.now);
  tracker.recordRequest({ status: 'ok', usage: usage(1900, 40), costUsd: 0.0002, totalMs: 900 });
  tracker.recordRequest({ status: 'ok', usage: usage(2, 5, { cacheReadTokens: 1000, cacheWriteTokens: 500 }), costUsd: 0.0001, totalMs: 1100 });
  tracker.recordRequest({ status: 'cancelled', usage: usage(1800, 3), costUsd: 0, totalMs: 200 });
  tracker.recordRequest({ status: 'timeout', usage: usage(0, 0), costUsd: 0, totalMs: 8000 });
  tracker.recordRequest({ status: 'error', usage: usage(0, 0), costUsd: 0, totalMs: 50 });
  tracker.recordShown();
  tracker.recordShown();
  tracker.recordAccepted();
  tracker.recordLocalHit();

  const today = tracker.today();
  assert.equal(today.date, '2026-11-11');
  assert.equal(today.requests, 5);
  assert.equal(today.inputTokens, 3702);
  assert.equal(today.outputTokens, 48);
  assert.equal(today.cacheReadTokens, 1000);
  assert.equal(today.cacheWriteTokens, 500);
  assert.equal(totalTokens(today), 3702 + 1000 + 500 + 48);
  assert.equal(today.cancelled, 1);
  assert.equal(today.timeouts, 1);
  assert.equal(today.errors, 1);
  assert.equal(today.shown, 2);
  assert.equal(today.accepted, 1);
  assert.equal(today.localHits, 1);
  assert.equal(acceptanceRate(today), 0.5);
  // Only successful requests feed the latency and input-token samples.
  assert.deepEqual(today.latencies, [900, 1100]);
  assert.deepEqual(tracker.latency(), { p50: 900, p95: 1100 });
  assert.equal(tracker.medianInputTokens(), 1502);
});

test('tracker: tokens of requests cut off before answering are kept apart, not counted as free or as spent', async () => {
  const store = memoryStore();
  const tracker = new UsageTracker(store, clock('2026-11-11T10:00:00').now);
  tracker.recordRequest({ status: 'cancelled', usage: usage(0, 0), costUsd: 0, totalMs: 900 });
  tracker.recordUnconfirmed(1830.4);
  tracker.recordUnconfirmed(-5);
  assert.equal(tracker.today().unconfirmedTokens, 1830);
  assert.equal(tracker.today().inputTokens, 0);
  assert.equal(totalTokens(tracker.today()), 0);
  await tracker.flush();
  assert.equal(new UsageTracker(store, clock('2026-11-11T10:00:00').now).today().unconfirmedTokens, 1830);
  // Days stored before this counter existed read as zero.
  store.data.set('ghostline.usage.v1', [{ date: '2026-11-11', requests: 3 }]);
  assert.equal(new UsageTracker(store, clock('2026-11-11T10:00:00').now).today().unconfirmedTokens, 0);
});

test('tracker: spend by time, for the share of a Claude session that is ghostline’s', async () => {
  const store = memoryStore();
  const time = clock('2026-11-11T22:50:00Z');
  const tracker = new UsageTracker(store, time.now);
  const at = (iso: string): number => Date.parse(iso);
  const close = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

  tracker.recordRequest({ status: 'ok', usage: usage(1900), costUsd: 0.00025, totalMs: 900 });
  tracker.recordRequest({ status: 'ok', usage: usage(1900), costUsd: 0.00025, totalMs: 900 });
  // The session runs across midnight: the calendar day does not matter here.
  time.set('2026-11-12T00:20:00Z');
  tracker.recordRequest({ status: 'ok', usage: usage(1900), costUsd: 0.0003, totalMs: 900 });
  close(tracker.spentSince(at('2026-11-11T22:00:00Z')), 0.0008);
  close(tracker.spentSince(at('2026-11-12T00:00:00Z')), 0.0003);
  // Whole quarters of an hour: a session that began at 22:55 still counts the 22:45 quarter.
  close(tracker.spentSince(at('2026-11-11T22:55:00Z')), 0.0008);
  close(tracker.spentSince(at('2026-11-11T23:00:00Z')), 0.0003);
  assert.equal(tracker.spentSince(at('2026-11-12T00:30:00Z')), 0);

  // A request cut off before answering is priced as if billed, at today's measured rate per token
  // (which requests count as today's depends on the time zone the test runs in).
  const today = tracker.today();
  tracker.recordUnconfirmed(1900);
  close(tracker.spentSince(at('2026-11-12T00:00:00Z')), 0.0003 + 1900 * (today.costUsd / today.inputTokens));
  assert.equal(tracker.today().costUsd, today.costUsd);
  const total = tracker.spentSince(at('2026-11-11T22:00:00Z'));

  // Another window adds to it instead of overwriting; both see the total after flushing.
  await tracker.flush();
  const other = new UsageTracker(store, time.now);
  close(other.spentSince(at('2026-11-11T22:00:00Z')), total);
  other.recordRequest({ status: 'ok', usage: usage(1900), costUsd: 0.001, totalMs: 900 });
  await other.flush();
  await tracker.flush();
  close(tracker.spentSince(at('2026-11-11T22:00:00Z')), total + 0.001);

  // Kept for eight days, then dropped.
  time.set('2026-11-21T00:00:00Z');
  tracker.recordRequest({ status: 'ok', usage: usage(1900), costUsd: 0.00025, totalMs: 900 });
  await tracker.flush();
  close(new UsageTracker(store, time.now).spentSince(0), 0.00025);
  await tracker.reset();
  assert.equal(new UsageTracker(store, time.now).spentSince(0), 0);
});

test('tracker: a cut-off request before anything was measured is priced as a typical completion', () => {
  const tracker = new UsageTracker(memoryStore(), clock('2026-11-11T10:00:00Z').now);
  tracker.recordUnconfirmed(1900);
  assert.ok(Math.abs(tracker.spentSince(0) - 0.00025) < 1e-9);
  // A broken or foreign value in storage is ignored.
  const store = memoryStore();
  store.data.set('ghostline.spend.v1', [['x', 1], [Date.parse('2026-11-11T09:00:00Z'), -3], 'nope', [Date.parse('2026-11-11T09:00:00Z'), 0.5]]);
  assert.equal(new UsageTracker(store, clock('2026-11-11T10:00:00Z').now).spentSince(0), 0.5);
});

test('tracker: acceptance rate is undefined until something was shown', () => {
  const tracker = new UsageTracker(memoryStore());
  assert.equal(acceptanceRate(tracker.today()), undefined);
});

test('tracker: daily limit', () => {
  const tracker = new UsageTracker(memoryStore());
  for (let i = 0; i < 3; i++) tracker.recordRequest({ status: 'ok', usage: usage(10), costUsd: 0, totalMs: 1 });
  assert.equal(tracker.overDailyLimit(4), false);
  assert.equal(tracker.overDailyLimit(3), true);
  assert.equal(tracker.overDailyLimit(0), false); // 0 = no limit
});

test('tracker: survives a restart through the store', async () => {
  const store = memoryStore();
  const time = clock('2026-11-11T10:00:00');
  const first = new UsageTracker(store, time.now);
  first.recordRequest({ status: 'ok', usage: usage(1000), costUsd: 0.001, totalMs: 700 });
  first.recordShown();
  await first.flush();

  const second = new UsageTracker(store, time.now);
  assert.equal(second.today().requests, 1);
  assert.equal(second.today().shown, 1);
  assert.deepEqual(second.today().latencies, [700]);
});

test('tracker: two windows add up instead of overwriting each other', async () => {
  const store = memoryStore();
  const time = clock('2026-11-11T10:00:00');
  const a = new UsageTracker(store, time.now);
  const b = new UsageTracker(store, time.now);
  a.recordRequest({ status: 'ok', usage: usage(100), costUsd: 0, totalMs: 500 });
  b.recordRequest({ status: 'ok', usage: usage(200), costUsd: 0, totalMs: 600 });
  b.recordRequest({ status: 'ok', usage: usage(300), costUsd: 0, totalMs: 700 });
  await a.flush();
  await b.flush();
  await a.flush(); // nothing pending: just picks up what b wrote

  for (const tracker of [a, b, new UsageTracker(store, time.now)]) {
    assert.equal(tracker.today().requests, 3);
    assert.equal(tracker.today().inputTokens, 600);
    assert.deepEqual([...tracker.today().latencies].sort(), [500, 600, 700]);
  }
});

test('tracker: a new day starts at zero, old days are compacted and only 30 are kept', async () => {
  const store = memoryStore();
  const time = clock('2026-01-01T12:00:00');
  const tracker = new UsageTracker(store, time.now);
  for (let day = 1; day <= 40; day++) {
    time.set(new Date(2026, 0, day, 12).toISOString());
    tracker.recordRequest({ status: 'ok', usage: usage(1000 + day), costUsd: 0, totalMs: 100 * day });
    await tracker.flush();
  }
  const stored = store.data.get('ghostline.usage.v1') as Array<{ date: string; latencies: number[]; p50?: number }>;
  assert.equal(stored.length, 30);
  assert.equal(stored[0]?.date, localDate(new Date(2026, 0, 40, 12)));
  // Past days keep percentiles, not raw samples.
  assert.deepEqual(stored[1]?.latencies, []);
  assert.equal(stored[1]?.p50, 3900);

  time.set(new Date(2026, 0, 41, 12).toISOString());
  assert.equal(tracker.today().requests, 0);
  const week = tracker.lastDays(7);
  assert.equal(week.length, 7);
  assert.equal(week[0]?.requests, 0);
  assert.equal(week[1]?.requests, 1);
  assert.equal(tracker.latency(week[1]).p50, 4000);
  assert.equal(tracker.medianInputTokens(week[1]), 1040);
});

test('tracker: reset clears everything', async () => {
  const store = memoryStore();
  const tracker = new UsageTracker(store);
  tracker.recordRequest({ status: 'ok', usage: usage(100), costUsd: 0, totalMs: 1 });
  await tracker.flush();
  await tracker.reset();
  assert.equal(tracker.today().requests, 0);
  assert.equal(new UsageTracker(store).today().requests, 0);
});

test('tracker: corrupt stored data is ignored', () => {
  const store = memoryStore();
  store.data.set('ghostline.usage.v1', [null, 'nope', { date: 42 }, { date: '2026-11-11', requests: 'many', latencies: 'x' }]);
  const tracker = new UsageTracker(store, clock('2026-11-11T10:00:00').now);
  assert.equal(tracker.today().requests, 0);
  assert.deepEqual(tracker.today().latencies, []);
});

test('estimator: starts from the measured defaults', () => {
  const estimator = new TokenEstimator();
  assert.equal(estimator.charsPerToken, DEFAULT_CHARS_PER_TOKEN);
  assert.equal(estimator.overheadTokens, DEFAULT_OVERHEAD_TOKENS);
  assert.equal(estimator.estimateTotal(2400), Math.round(DEFAULT_OVERHEAD_TOKENS + 2400 / DEFAULT_CHARS_PER_TOKEN));
});

test('estimator: learns overhead and ratio from varied real usage', () => {
  const estimator = new TokenEstimator();
  // A different language/model: 3.2 chars per token and 700 tokens of overhead.
  for (let i = 0; i < 60; i++) {
    const chars = 500 + ((i * 37) % 30) * 100;
    estimator.observe(chars, Math.round(700 + chars / 3.2));
  }
  assert.ok(Math.abs(estimator.charsPerToken - 3.2) < 0.05, `ratio ${estimator.charsPerToken}`);
  assert.ok(Math.abs(estimator.overheadTokens - 700) < 15, `overhead ${estimator.overheadTokens}`);
  assert.ok(Math.abs(estimator.estimateTotal(3200) - 1700) < 15);
});

test('estimator: with prompts of one size it still predicts that size correctly', () => {
  const estimator = new TokenEstimator();
  for (let i = 0; i < 30; i++) estimator.observe(2400 + (i % 3), 1900);
  // Not enough spread to learn the ratio, so the default stays…
  assert.equal(estimator.charsPerToken, DEFAULT_CHARS_PER_TOKEN);
  // …and the overhead absorbs the difference: the prediction at the operating point is right.
  assert.ok(Math.abs(estimator.estimateTotal(2400) - 1900) < 5);
});

test('estimator: nonsense is clamped or ignored, and state round-trips', () => {
  const estimator = new TokenEstimator();
  estimator.observe(0, 100);
  estimator.observe(100, 0);
  estimator.observe(Number.NaN, 5);
  assert.equal(estimator.samples, 0);
  for (let i = 0; i < 50; i++) estimator.observe(100 + i * 100, 50_000 + i * 5000);
  assert.ok(estimator.charsPerToken >= 1.5 && estimator.charsPerToken <= 5);
  assert.ok(estimator.overheadTokens >= 300 && estimator.overheadTokens <= 3000);

  const restored = new TokenEstimator(JSON.parse(JSON.stringify(estimator)));
  assert.equal(restored.charsPerToken, estimator.charsPerToken);
  assert.equal(restored.overheadTokens, estimator.overheadTokens);
  // Garbage from storage falls back to the defaults.
  assert.equal(new TokenEstimator({ n: 'x' }).overheadTokens, DEFAULT_OVERHEAD_TOKENS);
  assert.equal(new TokenEstimator(null).charsPerToken, DEFAULT_CHARS_PER_TOKEN);
});
