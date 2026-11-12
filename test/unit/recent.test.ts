import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecentSuggestions, formatRecent, type RecentEntry } from '../../src/usage/recent';
import type { KeyValueStore } from '../../src/usage/usageTracker';

function memoryStore(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    update: (key, value) => {
      if (value === undefined) data.delete(key);
      else data.set(key, structuredClone(value));
    },
  };
}

function entry(overrides: Partial<RecentEntry> = {}): RecentEntry {
  return {
    id: 1,
    at: Date.parse('2026-11-12T19:10:50'),
    file: 'api/core.go',
    languageId: 'go',
    context: 'mid-line',
    manual: false,
    before: '\tmessages',
    after: ' c.queries.ListContextMessages(ctx, conversationID)',
    raw: '= ghostline Model',
    shown: '= ghostline Model',
    hints: ['2 ej.'],
    outcome: 'sin resolver',
    inputTokens: 1930,
    thinkingTokens: 0,
    totalMs: 1067,
    ...overrides,
  };
}

test('recent: answers are kept with their outcome, newest first, and survive a reload', () => {
  const store = memoryStore();
  const recent = new RecentSuggestions(store);
  recent.add(entry({ id: 34 }));
  recent.add(entry({ id: 35, shown: '', raw: '<none/>', outcome: 'vacía' }));
  recent.resolve(34, 'aceptada');
  // An outcome for a request that left no entry (a cache hit, say) changes nothing.
  recent.resolve(99, 'ignorada');
  assert.deepEqual(
    recent.list().map((item) => [item.id, item.outcome]),
    [
      [35, 'vacía'],
      [34, 'aceptada'],
    ],
  );
  assert.deepEqual(
    new RecentSuggestions(store).list().map((item) => [item.id, item.outcome]),
    [
      [35, 'vacía'],
      [34, 'aceptada'],
    ],
  );
});

test('recent: bounded in number and in size; request numbers restart with each window', () => {
  const store = memoryStore();
  const recent = new RecentSuggestions(store);
  for (let id = 1; id <= 55; id++) recent.add(entry({ id }));
  assert.equal(recent.list().length, 40);
  assert.equal(recent.list()[0]?.id, 55);
  assert.equal(recent.list().at(-1)?.id, 16);
  recent.add(entry({ id: 56, before: 'x'.repeat(500) + 'END', after: 'START' + 'y'.repeat(500), raw: 'r'.repeat(2000), shown: 's'.repeat(2000) }));
  const long = recent.list()[0] as RecentEntry;
  assert.ok(long.before.length <= 160 && long.before.endsWith('END'));
  assert.ok(long.after.length <= 160 && long.after.startsWith('START'));
  assert.ok(long.raw.length <= 400 && long.shown.length <= 400);
  // After a reload the window counts from 1 again: an outcome goes to the latest entry with that number.
  const reloaded = new RecentSuggestions(store);
  reloaded.add(entry({ id: 20, shown: 'new' }));
  reloaded.resolve(20, 'ignorada');
  const twenties = reloaded.list().filter((item) => item.id === 20);
  assert.deepEqual(twenties.map((item) => item.outcome), ['ignorada', 'sin resolver']);
  reloaded.clear();
  assert.equal(new RecentSuggestions(store).list().length, 0);
  // Foreign or broken stored data is ignored.
  store.data.set('ghostline.recent.v1', [null, { id: 'x' }, 'nope']);
  assert.equal(new RecentSuggestions(store).list().length, 0);
});

test('recent: the view shows the line with the cursor, what was offered and, when it differs, what the model said', () => {
  const text = formatRecent([
    entry({ id: 34, outcome: 'aceptada' }),
    entry({ id: 35, context: 'new-line', before: '\t', after: '', raw: '`if err != nil {\n\t}\n`', shown: 'if err != nil {\n\t}', thinkingTokens: 120, hints: ['símbolos: ListContextMessages, queries'] }),
    entry({ id: 36, raw: '<none/>', shown: '', outcome: 'vacía', manual: true }),
  ]);
  assert.match(text, /api\/core\.go · go mid-line · ACEPTADA · 1930 tok · 1067 ms · 2 ej\./);
  assert.match(text, /línea: {4}⇥messages▮ c\.queries\.ListContextMessages\(ctx, conversationID\)/);
  assert.match(text, /ofrecido: = ghostline Model\n\n/);
  assert.match(text, /go new-line · SIN RESOLVER · 1930 tok · 1067 ms \(razonó\) · símbolos: ListContextMessages, queries/);
  assert.match(text, /ofrecido: if err != nil \{⏎⇥\}\n {2}modelo: {3}`if err != nil \{⏎⇥\}⏎`/);
  assert.match(text, /go mid-line \(manual\) · VACÍA/);
  assert.match(text, /ofrecido: \(nada\)\n {2}modelo: {3}<none\/>/);
  assert.match(formatRecent([]), /todavía no ha recibido ninguna respuesta/);
});
