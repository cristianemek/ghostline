import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProjectIndex, declarationsOf, isIndexable, projectBlock, type IndexedFile } from '../../src/context/projectIndex';

test('index: Go functions, methods and types with their fields', () => {
  const source = [
    'package main',
    '',
    'const defaultModel = "claude-sonnet-5-5"',
    '',
    'type core struct {',
    '\tprovider llm.Provider',
    '\tqueries  *gen.Queries',
    '}',
    '',
    'func (c *core) startTurn(ctx context.Context, conversationID pgtype.UUID, question string) (pgtype.UUID, []llm.Message, error) {',
    '\treturn pgtype.UUID{}, nil, nil',
    '}',
    '',
    'func toLLMMessages(rows []gen.ListContextMessagesRow) ([]llm.Message, error) {',
    '\tfunc() { nested() }()',
    '\treturn nil, nil',
    '}',
  ].join('\n');
  assert.deepEqual(declarationsOf(source, 'api/core.go'), [
    'type core struct { provider llm.Provider; queries *gen.Queries }',
    'func (c *core) startTurn(ctx context.Context, conversationID pgtype.UUID, question string) (pgtype.UUID, []llm.Message, error)',
    'func toLLMMessages(rows []gen.ListContextMessagesRow) ([]llm.Message, error)',
  ]);
});

test('index: TypeScript lists what a module exports, with public methods; values never travel', () => {
  const source = [
    "import { api } from './api';",
    '',
    'const internal = 1;',
    'export const API_KEY = "sk-live-0123456789abcdef0123";',
    'export const useOrders = (filters: OrderFilters) => {',
    '  return api.get(filters);',
    '};',
    'export interface OrderFilters {',
    '  status?: string;',
    '  from: Date;',
    '}',
    'export default async function loadOrders(filters: OrderFilters): Promise<Order[]> {',
    '  return [];',
    '}',
    'function helper() {}',
    'export class OrderService {',
    '  private cache = new Map<string, Order>();',
    '',
    '  constructor(private readonly http: Http) {}',
    '',
    '  async list(filters: OrderFilters = {}): Promise<Order[]> {',
    '    if (filters.status) {',
    '      return [];',
    '    }',
    '    return [];',
    '  }',
    '',
    '  private refresh(): void {}',
    '',
    '  static create(http: Http): OrderService {',
    '    return new OrderService(http);',
    '  }',
    '}',
    'export type Id = string;',
  ].join('\n');
  assert.deepEqual(declarationsOf(source, 'src/orders.ts'), [
    'export const API_KEY',
    'export const useOrders = (filters: OrderFilters) =>',
    'export interface OrderFilters { status?: string; from: Date }',
    'export default async function loadOrders(filters: OrderFilters): Promise<Order[]>',
    'export class OrderService',
    '  async list(filters: OrderFilters = {}): Promise<Order[]>',
    '  static create(http: Http): OrderService',
    'export type Id = string;',
  ]);
});

test('index: Python and Rust top-level declarations; other files give nothing', () => {
  const python = ['import os', '', 'class OrderService(Base):', '    def list(self, filters=None):', '        return []', '', '    def _private(self):', '        pass', '', 'def compute_total(items, tax_rate=0.21):', '    return 0'].join('\n');
  assert.deepEqual(declarationsOf(python, 'app/orders.py'), ['class OrderService(Base):', '  def list(self, filters=None):', 'def compute_total(items, tax_rate=0.21):']);
  const rust = ['use std::fmt;', '', 'pub struct Point {', '    x: f64,', '    y: f64,', '}', '', 'pub fn distance(a: &Point, b: &Point) -> f64 {', '    0.0', '}', 'fn private_helper() {}'].join('\n');
  assert.deepEqual(declarationsOf(rust, 'src/geometry.rs'), ['pub struct Point { x: f64; y: f64 }', 'pub fn distance(a: &Point, b: &Point) -> f64', 'fn private_helper()']);
  assert.deepEqual(declarationsOf('SECRET=1\nfunc notGo() {}', '.env'), []);
  assert.deepEqual(declarationsOf('# title\n', 'README.md'), []);

  assert.equal(isIndexable('api/core.go'), true);
  assert.equal(isIndexable('src/App.tsx'), true);
  assert.equal(isIndexable('src/types.d.ts'), false);
  assert.equal(isIndexable('.env'), false);
  assert.equal(isIndexable('docs/notes.md'), false);
});

test('index: a file that declares a lot is capped', () => {
  const source = Array.from({ length: 200 }, (_, i) => `func f${i}() {}`).join('\n');
  assert.equal(declarationsOf(source, 'big.go').length, 60);
});

const files: IndexedFile[] = [
  { path: 'api/core.go', declarations: ['func a()', 'func b()'] },
  { path: 'api/db/gen/models.go', declarations: ['type Message struct { ID string }'] },
  { path: 'widget/src/chat.ts', declarations: ['export function mount(): void'] },
  { path: 'api/auth.go', declarations: ['func requireAuth(next http.Handler) http.Handler'] },
  { path: 'api/empty.go', declarations: [] },
];

test('index: a project that fits is listed whole in path order, whatever file is open', () => {
  const whole = buildProjectIndex(files, 'widget/src/chat.ts', 10_000);
  assert.equal(
    whole.text,
    [
      '// api/auth.go',
      'func requireAuth(next http.Handler) http.Handler',
      '// api/core.go',
      'func a()',
      'func b()',
      '// api/db/gen/models.go',
      'type Message struct { ID string }',
      '// widget/src/chat.ts',
      'export function mount(): void',
    ].join('\n'),
  );
  assert.deepEqual([whole.files, whole.declarations, whole.omitted], [4, 5, 0]);
  // The same text from any file: that is what lets the prompt cache keep serving it.
  assert.equal(buildProjectIndex(files, 'api/core.go', 10_000).text, whole.text);
  assert.equal(buildProjectIndex([...files].reverse(), undefined, 10_000).text, whole.text);
});

test('index: one that does not fit starts from the folder being edited and moves away from it', () => {
  const near = buildProjectIndex(files, 'api/handlers.go', 150);
  assert.ok(near.text.startsWith('// api/auth.go\n'), near.text);
  assert.ok(near.text.includes('// api/core.go'));
  assert.ok(!near.text.includes('widget/'), near.text);
  assert.ok(near.text.endsWith('more files not listed)'));
  assert.ok(near.omitted >= 1 && near.text.length <= 150 + 40);
  const far = buildProjectIndex(files, 'widget/src/app.ts', 150);
  assert.ok(far.text.startsWith('// widget/src/chat.ts\n'), far.text);
  // Children of the folder come before unrelated ones.
  const child = buildProjectIndex(files, 'api/core.go', 160);
  assert.ok(child.text.indexOf('// api/db/gen/models.go') > 0 && !child.text.includes('widget/'), child.text);
});

test('index: the block for the system prompt, and nothing when there is nothing', () => {
  const block = projectBlock(buildProjectIndex(files, undefined, 10_000));
  assert.ok(block.startsWith('\n<project>\nFunctions and types this project declares'));
  assert.ok(block.includes('// api/core.go\nfunc a()\nfunc b()\n'));
  assert.ok(block.endsWith('\n</project>\n'));
  assert.equal(projectBlock(buildProjectIndex([], undefined, 10_000)), '');
  assert.equal(projectBlock(buildProjectIndex([{ path: 'a.go', declarations: [] }], undefined, 10_000)), '');
});
