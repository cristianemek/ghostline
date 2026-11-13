import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SuggestionInfo } from '../../src/completion/hooks';
import { buildPrompt, DEFAULT_LIMITS } from '../../src/completion/promptBuilder';
import { AdaptiveTrigger } from '../../src/learning/adaptiveTrigger';
import { DEFAULT_SELECT, ExampleStore } from '../../src/learning/exampleStore';
import { Learning } from '../../src/learning/learning';
import { identifiers, jaccard } from '../../src/learning/similarity';
import {
  MAX_PROFILE_CHARS,
  buildStylePrompt,
  capProfile,
  cleanStyleGuide,
  isStyleCandidate,
  pickStyleFiles,
} from '../../src/learning/styleProfile';
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

const SELECT = { ...DEFAULT_SELECT, charsPerToken: 2.7 };

test('identifiers: distinct names, lower-cased, without keywords or one-letter names', () => {
  assert.deepEqual(
    [...identifiers('const userName = getUser(id).name; return userName;')].sort(),
    ['getuser', 'id', 'name', 'username'],
  );
  assert.deepEqual([...identifiers('if (a) { return b; }')], []);
  assert.deepEqual([...identifiers('$scope.total_count += 1')].sort(), ['$scope', 'total_count']);
});

test('jaccard: shared over union', () => {
  const set = (...items: string[]) => new Set(items);
  assert.equal(jaccard(set('a', 'b'), set('a', 'b')), 1);
  assert.equal(jaccard(set('a', 'b'), set('c')), 0);
  assert.equal(jaccard(set('a', 'b', 'c'), set('b', 'c', 'd')), 0.5);
  assert.equal(jaccard(set(), set('a')), 0);
  assert.equal(jaccard(set(), set()), 0);
});

test('examples: the most similar accepted completions are selected, at most two', () => {
  const store = new ExampleStore(memoryStore());
  store.add('typescript', 'const orders = await orderService.list(filters);\n', 'return orders.items.map(toOrderDto);');
  store.add('typescript', 'const orders = await orderService.listRecent(filters);\n', 'return orders.items.filter(isOpen);');
  store.add('typescript', 'app.get("/health", (req, res) => {\n', 'res.json({ status: "ok" });');
  store.add('typescript', 'const invoices = await invoiceService.list(filters);\n', 'return invoices.items.map(toInvoiceDto);');

  const picked = store.select('typescript', 'const orders = await orderService.list(query);\n', SELECT);
  assert.equal(picked.length, 2);
  assert.equal(picked[0]?.accepted, 'return orders.items.map(toOrderDto);');
  assert.ok(picked.every((example) => !example.accepted.includes('status')));
});

test('examples: unrelated code gets no examples at all', () => {
  const store = new ExampleStore(memoryStore());
  store.add('typescript', 'const orders = await orderService.list(filters);\n', 'return orders.items;');
  assert.deepEqual(store.select('typescript', 'function drawCircle(radius: number) {\n', SELECT), []);
  assert.deepEqual(store.select('python', 'orders = order_service.list(filters)\n', SELECT), []);
  assert.deepEqual(store.select('typescript', '  }\n', SELECT), []);
});

test('examples: the token budget is respected', () => {
  const store = new ExampleStore(memoryStore());
  const before = 'const orders = await orderService.list(filters);\n';
  store.add('typescript', before, 'return orders.items.map(toOrderDto); // ' + 'x'.repeat(400));
  store.add('typescript', before, 'return orders.items;');
  const tight = store.select('typescript', before, { ...SELECT, maxTokens: 60 });
  assert.equal(tight.length, 1);
  assert.equal(tight[0]?.accepted, 'return orders.items;');
  assert.deepEqual(store.select('typescript', before, { ...SELECT, maxTokens: 5 }), []);
  const examples = store.select('typescript', before, SELECT);
  const withExamples = buildPrompt({
    path: 'a.ts',
    languageId: 'typescript',
    prefix: before,
    suffix: '',
    examples,
    limits: { ...DEFAULT_LIMITS, targetTokens: 900, charsPerToken: 2.7 },
  });
  const without = buildPrompt({
    path: 'a.ts',
    languageId: 'typescript',
    prefix: before,
    suffix: '',
    limits: { ...DEFAULT_LIMITS, targetTokens: 900, charsPerToken: 2.7 },
  });
  assert.ok(withExamples.estimatedTokens - without.estimatedTokens <= 320);
});

test('examples: only the latest 200 per language are kept, and they persist', () => {
  const backing = memoryStore();
  let now = 0;
  const store = new ExampleStore(backing, () => ++now);
  for (let i = 0; i < 230; i++) store.add('go', `value${i} := compute${i}()\n`, `return value${i}`);
  store.add('rust', 'let total = sum(values);\n', 'total');
  assert.equal(store.count('go'), 200);
  assert.equal(store.count(), 201);

  const reopened = new ExampleStore(backing);
  assert.equal(reopened.count('go'), 200);
  assert.deepEqual(reopened.select('go', 'value0 := compute0()\n', SELECT), []);
  assert.equal(reopened.select('go', 'value229 := compute229()\n', SELECT)[0]?.accepted, 'return value229');
});

test('examples: duplicates are stored once, blanks never, and clear wipes everything', () => {
  const backing = memoryStore();
  const store = new ExampleStore(backing);
  store.add('ts', 'const a = load();\n', 'return a;');
  store.add('ts', 'const a = load();\n', 'return a;');
  store.add('ts', 'const a = load();\n', '   ');
  assert.equal(store.count('ts'), 1);
  store.clear();
  assert.equal(store.count(), 0);
  assert.equal(new ExampleStore(backing).count(), 0);
});

test('examples: corrupt stored data is ignored', () => {
  const backing = memoryStore();
  backing.data.set('ghostline.examples.v2', { ts: [null, { before: 1 }, { before: 'x', accepted: 'y', at: 1 }], py: 'nope' });
  backing.data.set('ghostline.examples.v1', { go: [{ before: 'c.queries.ListOrderItems(', accepted: 'ctx, orderID, nil', at: 1 }] });
  const store = new ExampleStore(backing);
  assert.equal(store.count('ts'), 1);
  assert.equal(store.count('py'), 0);
  assert.equal(store.count('go'), 0);
  assert.equal(backing.data.get('ghostline.examples.v1'), undefined);
});

test('adaptive: below 10 % acceptance over the last 40 shown, the context is muted for 24 h', () => {
  let now = 1_000_000;
  const trigger = new AdaptiveTrigger(memoryStore(), () => now);
  let mutedAt = -1;
  for (let i = 0; i < 40; i++) {
    if (trigger.record('typescript', 'after-dot', i < 3)) mutedAt = i;
    if (i < 39) assert.equal(trigger.isSuppressed('typescript', 'after-dot'), false, `shown ${i + 1}`);
  }
  assert.equal(mutedAt, 39);
  assert.equal(trigger.isSuppressed('typescript', 'after-dot'), true);
  assert.equal(trigger.isSuppressed('typescript', 'new-line'), false);
  assert.equal(trigger.isSuppressed('python', 'after-dot'), false);

  now += 24 * 3600_000 - 1;
  assert.equal(trigger.isSuppressed('typescript', 'after-dot'), true);
  now += 1;
  assert.equal(trigger.isSuppressed('typescript', 'after-dot'), false);
  for (let i = 0; i < 39; i++) assert.equal(trigger.record('typescript', 'after-dot', false), false);
  assert.equal(trigger.record('typescript', 'after-dot', false), true);
});

test('adaptive: 10 % or more keeps triggering', () => {
  const trigger = new AdaptiveTrigger(memoryStore());
  for (let i = 0; i < 200; i++) assert.equal(trigger.record('typescript', 'end-of-line', i % 10 === 0), false);
  assert.equal(trigger.isSuppressed('typescript', 'end-of-line'), false);
});

test('adaptive: it is the last 40 that count, not the whole history', () => {
  const trigger = new AdaptiveTrigger(memoryStore());
  for (let i = 0; i < 100; i++) trigger.record('go', 'new-line', true);
  let muted = false;
  let needed = 0;
  while (!muted && needed < 100) {
    muted = trigger.record('go', 'new-line', false);
    needed++;
  }
  assert.equal(needed, 37);
});

test('adaptive: state survives a restart and can be reported and cleared', () => {
  const backing = memoryStore();
  const now = 5_000;
  const first = new AdaptiveTrigger(backing, () => now);
  for (let i = 0; i < 40; i++) first.record('typescript', 'after-paren', false);
  first.record('typescript', 'new-line', true);

  const second = new AdaptiveTrigger(backing, () => now);
  assert.equal(second.isSuppressed('typescript', 'after-paren'), true);
  const report = second.report();
  assert.deepEqual(
    report.find((entry) => entry.context === 'new-line'),
    { languageId: 'typescript', context: 'new-line', shown: 1, accepted: 1, mutedUntil: undefined },
  );
  assert.equal(report.find((entry) => entry.context === 'after-paren')?.mutedUntil, now + 24 * 3600_000);
  second.clear();
  assert.equal(new AdaptiveTrigger(backing, () => now).isSuppressed('typescript', 'after-paren'), false);
});

function suggestion(overrides: Partial<SuggestionInfo> = {}): SuggestionInfo {
  return {
    id: 1,
    documentKey: 'file:///a.ts',
    languageId: 'typescript',
    context: 'end-of-line',
    manual: false,
    before: 'const orders = await orderService.list(filters);\n',
    text: 'return orders.items;',
    ...overrides,
  };
}

function createLearning(settings = { learningExamples: true, adaptiveTrigger: true }, profile?: string) {
  const examples = new ExampleStore(memoryStore());
  const adaptive = new AdaptiveTrigger(memoryStore());
  const muted: string[] = [];
  const documents = new Map<string, string>([['file:///a.ts', 'const orders = await orderService.list(filters);\nreturn orders.items;\n']]);
  const scheduled: { task: () => void; ms: number }[] = [];
  const learning = new Learning({
    examples,
    adaptive,
    styleProfile: () => profile,
    settings: () => settings,
    charsPerToken: () => 2.7,
    onMuted: (languageId, context) => muted.push(`${languageId}:${context}`),
    readDocument: (documentKey) => documents.get(documentKey),
    later: (task, ms) => scheduled.push({ task, ms }),
  });
  return { learning, examples, adaptive, muted, documents, scheduled };
}

test('learning: an accepted suggestion that stays in the file becomes an example for similar code', () => {
  const { learning, examples, scheduled } = createLearning({ learningExamples: true, adaptiveTrigger: true }, '- Use single quotes.');
  learning.onAccepted(suggestion());
  assert.equal(examples.count('typescript'), 0);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]?.ms, 10 * 60_000);
  scheduled[0]?.task();
  assert.equal(examples.count('typescript'), 1);
  const extras = learning.promptExtras('typescript', 'const orders = await orderService.list(query);\n');
  assert.equal(extras.styleProfile, '- Use single quotes.');
  assert.deepEqual(extras.examples, [{ before: suggestion().before, accepted: 'return orders.items;' }]);
  scheduled[0]?.task();
  learning.confirmPending();
  assert.equal(examples.count('typescript'), 1);
});

test('learning: a suggestion that was accepted and then fixed or removed never becomes an example', () => {
  const { learning, examples, documents } = createLearning();
  documents.set('file:///core.go', 'c.queries.ListOrderItems(ctx, orderID)\n');
  learning.onAccepted(suggestion({ documentKey: 'file:///core.go', languageId: 'go', before: '\tc.queries.ListOrderItems(', text: 'ctx, orderID, nil' }));
  learning.confirmPending();
  assert.equal(examples.count(), 0);
  learning.onAccepted(suggestion({ documentKey: 'file:///closed.ts' }));
  learning.confirmPending();
  assert.equal(examples.count(), 0);
  documents.set('file:///core.go', '\tKind:      in.Kind,\n\tTier:      defaultTier,\n');
  learning.onAccepted(suggestion({ documentKey: 'file:///core.go', languageId: 'go', before: '\t', text: 'Kind: in.Kind,\n\tTier: defaultTier,' }));
  learning.confirmPending();
  assert.equal(examples.count('go'), 1);
});

test('learning: with examples turned off nothing is stored or sent', () => {
  const { learning, examples } = createLearning({ learningExamples: false, adaptiveTrigger: true });
  learning.onAccepted(suggestion());
  assert.equal(examples.count(), 0);
  assert.equal(learning.promptExtras('typescript', suggestion().before).examples, undefined);
});

test('learning: ignored automatic suggestions mute the context; manual ones never count', () => {
  const { learning, muted } = createLearning();
  for (let i = 0; i < 100; i++) learning.onIgnored(suggestion({ manual: true }));
  assert.equal(learning.isSuppressed('typescript', 'end-of-line'), false);
  for (let i = 0; i < 40; i++) learning.onIgnored(suggestion());
  assert.equal(learning.isSuppressed('typescript', 'end-of-line'), true);
  assert.deepEqual(muted, ['typescript:end-of-line']);
});

test('learning: the adaptive trigger can be switched off', () => {
  const { learning, muted } = createLearning({ learningExamples: true, adaptiveTrigger: false });
  for (let i = 0; i < 40; i++) learning.onIgnored(suggestion());
  assert.equal(learning.isSuppressed('typescript', 'end-of-line'), false);
  assert.deepEqual(muted, []);
});

test('style: only hand-written source files are candidates', () => {
  for (const path of ['src/app.ts', 'lib/util.py', 'cmd/main.go', 'src/App.vue']) assert.equal(isStyleCandidate(path), true, path);
  for (const path of ['README.md', 'package.json', 'dist/app.min.js', 'types/index.d.ts', 'api/service_pb2.py', 'data.csv', 'Makefile']) {
    assert.equal(isStyleCandidate(path), false, path);
  }
});

test('style: picks medium files of the main language, one per folder first, tests last', () => {
  const candidates = [
    { path: 'src/a/service.ts', size: 4200 },
    { path: 'src/a/other.ts', size: 3900 },
    { path: 'src/b/controller.ts', size: 5000 },
    { path: 'src/c/model.ts', size: 2500 },
    { path: 'src/d/huge.ts', size: 400_000 },
    { path: 'src/e/tiny.ts', size: 40 },
    { path: 'src/f/routes.ts', size: 3000 },
    { path: 'test/service.test.ts', size: 4000 },
    { path: 'scripts/build.py', size: 4000 },
    { path: 'docs/readme.md', size: 4000 },
  ];
  const picked = pickStyleFiles(candidates).map((candidate) => candidate.path);
  assert.equal(picked.length, 5);
  assert.deepEqual(new Set(picked), new Set(['src/a/service.ts', 'src/b/controller.ts', 'src/c/model.ts', 'src/f/routes.ts', 'src/a/other.ts']));
  assert.equal(new Set(picked.slice(0, 4).map((path) => path.split('/')[1])).size, 4);
});

test('style: the language being edited is preferred, and other languages fill in', () => {
  const candidates = [
    { path: 'src/a.ts', size: 4000 },
    { path: 'src/b.ts', size: 4000 },
    { path: 'src/c.ts', size: 4000 },
    { path: 'tools/x.py', size: 4000 },
    { path: 'tools/y.py', size: 4000 },
  ];
  assert.deepEqual(
    pickStyleFiles(candidates, { preferredExtension: 'py', max: 3 }).map((candidate) => candidate.path),
    ['tools/x.py', 'tools/y.py', 'src/a.ts'],
  );
  assert.deepEqual(pickStyleFiles([], {}), []);
  assert.deepEqual(pickStyleFiles([{ path: 'notes.md', size: 100 }]), []);
});

test('style: the request stays within ~6k tokens whatever the files', () => {
  const big = Array.from({ length: 3000 }, (_, i) => `export const value${i} = ${i};`).join('\n');
  const files = Array.from({ length: 5 }, (_, i) => ({ path: `src/file${i}.ts`, content: big }));
  const prompt = buildStylePrompt(files, 2.7);
  assert.ok(prompt.length / 2.7 <= 6000, `${Math.round(prompt.length / 2.7)} tokens`);
  assert.ok(prompt.length / 2.7 > 5000);
  assert.equal(prompt.match(/<file path="/g)?.length, 5);
  assert.ok(prompt.includes('<file path="src/file0.ts">\nexport const value0 = 0;'));
  assert.ok(!/= \d+\n<\/file>/.test(prompt) || /;\n<\/file>/.test(prompt));
  assert.equal(buildStylePrompt([{ path: 'a.ts', content: 'const a = 1;\r\n' }], 2.7), '<file path="a.ts">\nconst a = 1;\n</file>');
  assert.equal(buildStylePrompt([], 2.7), '');
});

test('style: the answer is tidied and capped to what is sent with every request', () => {
  assert.equal(cleanStyleGuide('```\n- Use single quotes.\n- 2 spaces.\n```'), '- Use single quotes.\n- 2 spaces.');
  assert.equal(
    cleanStyleGuide("Here's the style guide:\n\n## Style\n- camelCase for variables.\n\n\n\n- No semicolons.\n"),
    '- camelCase for variables.\n\n- No semicolons.',
  );
  const long = Array.from({ length: 60 }, (_, i) => `- Convention number ${i} about naming things.`).join('\n');
  const capped = cleanStyleGuide(long);
  assert.ok(capped.length <= MAX_PROFILE_CHARS);
  assert.ok(capped.endsWith('.'), 'cut on a line boundary');
  assert.equal(cleanStyleGuide('   '), '');
  assert.equal(capProfile('short'), 'short');
  assert.equal(capProfile('x'.repeat(2000)).length, MAX_PROFILE_CHARS);
});
