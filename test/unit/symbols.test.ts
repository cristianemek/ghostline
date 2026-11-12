import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrompt, DEFAULT_LIMITS } from '../../src/completion/promptBuilder';
import { enclosingOpener, extractSignature, formatSymbols, pickIdentifiers, pickIdentifiersAfter } from '../../src/context/symbolText';

test('identifiers after the cursor: nearest first, for an insertion in front of existing code', () => {
  // Return values being named in front of a call that was already written.
  const rest = ' c.queries.ListOrderItems(ctx, orderID)';
  assert.deepEqual(pickIdentifiersAfter(rest), [
    { name: 'queries', character: rest.indexOf('queries') },
    { name: 'ListOrderItems', character: rest.indexOf('ListOrderItems') },
    { name: 'ctx', character: rest.indexOf('ctx') },
  ]);
  assert.deepEqual(
    pickIdentifiersAfter('compute(total, "not this one", rate) // nor this', 5).map((use) => use.name),
    ['compute', 'total', 'rate'],
  );
  assert.deepEqual(pickIdentifiersAfter(')'), []);
  assert.deepEqual(pickIdentifiersAfter(''), []);
});

test('prompt: with code after the cursor on its line, the line is shown again with the cursor marked', () => {
  const limits = { ...DEFAULT_LIMITS, targetTokens: 900, charsPerToken: 2.7 };
  const midLine = buildPrompt({
    path: 'api/core.go',
    languageId: 'go',
    prefix: 'func run() {\n\titems',
    suffix: ' c.queries.ListOrderItems(ctx, orderID)\n}\n',
    limits,
  });
  assert.ok(midLine.text.endsWith('</file>\n<line>items▮ c.queries.ListOrderItems(ctx, orderID)</line>'), midLine.text.slice(-120));
  // …and the caller is told, so that it turns the whole line the model answers into an insertion.
  assert.deepEqual(midLine.line, { before: 'items', after: ' c.queries.ListOrderItems(ctx, orderID)' });
  // At the end of the line, before closing characters, or on an empty line there is nothing to add.
  for (const [prefix, suffix] of [
    ['func run() {\n\tx := compute(', ')\n}\n'],
    ['func run() {\n\tx := ', '\n}\n'],
    ['func run() {\n\t', 'existing()\n}\n'],
  ] as const) {
    const built = buildPrompt({ path: 'a.go', languageId: 'go', prefix, suffix, limits });
    assert.ok(!built.text.includes('<line>'), prefix);
    assert.equal(built.line, undefined);
  }
  // A line too long to repeat is left to the plain insertion.
  const long = buildPrompt({ path: 'a.go', languageId: 'go', prefix: `\tx := ${'a'.repeat(400)}, `, suffix: 'rest()\n', limits });
  assert.equal(long.line, undefined);
});

test('type declarations bring their members: names and types, never values', () => {
  // The struct from the session that prompted this (generated output).
  const go = [
    'type CreateOrderParams struct {',
    '\tKind      Kind',
    '\tTier      string',
    '\tCustomerType CustomerType',
    '\tCustomerID   string `json:"identity_id"`',
    '\tSource   pgtype.Text // nullable',
    '\tCurrency     string',
    '}',
    '',
    'func (q *Queries) CreateOrder(ctx context.Context, arg CreateOrderParams) (Order, error) {',
  ];
  assert.equal(
    extractSignature(go, 0),
    'type CreateOrderParams struct { Kind Kind; Tier string; CustomerType CustomerType; CustomerID string; Source pgtype.Text; Currency string }',
  );
  // Asked not to (a definition outside the workspace): the head only, as before.
  assert.equal(extractSignature(go, 0, false), 'type CreateOrderParams struct');

  const ts = [
    'export interface ReportOptions extends Base {',
    '  /** Shown at the top. */',
    '  title: string;',
    '  taxRate: number; // percent',
    '  currency?: string;',
    '  address: {',
    '    street: string;',
    '  };',
    '  onDone: (total: number) => void;',
    '}',
  ];
  assert.equal(
    extractSignature(ts, 0),
    'export interface ReportOptions extends Base { title: string; taxRate: number; currency?: string; address: {…}; onDone: (total: number) => void }',
  );
  assert.equal(extractSignature(['type Filters = {', '  from: Date;', '  to: Date;', '};'], 0), 'type Filters = { from: Date; to: Date }');
  assert.equal(
    extractSignature(['pub enum Shape {', '    Circle { radius: f64 },', '    Square(f64),', '}'], 0),
    'pub enum Shape { Circle { radius: f64 }; Square(f64) }',
  );
  // Values assigned inside a type body stay behind.
  assert.equal(
    extractSignature(['export enum Keys {', '  Live = "sk-live-0123456789abcdef",', '  Test = 2,', '}'], 0),
    'export enum Keys { Live; Test }',
  );
});

test('type declarations: only real type bodies, cut short when long', () => {
  // A class or an object holds code and values, not just a shape.
  assert.equal(extractSignature(['export class Store {', '  private token = "abc";', '}'], 0), 'export class Store');
  assert.equal(extractSignature(['const type = {', '  apiKey: "sk-live-0123456789",', '};'], 0), 'const type');
  assert.equal(extractSignature(['export const config = {', '  retries: 3,', '};'], 0), 'export const config');
  // No body in sight: the head.
  assert.equal(extractSignature(['export interface Order {'], 0), 'export interface Order');
  const many = ['interface Big {', ...Array.from({ length: 30 }, (_, i) => `  field${i}: string;`), '}'];
  const cut = extractSignature(many, 0);
  assert.ok(cut.includes('field15: string; … }'), cut);
  assert.ok(!cut.includes('field16'), cut);
  const wide = ['interface Wide {', ...Array.from({ length: 10 }, (_, i) => `  field${i}: ${'VeryLongTypeName'.repeat(5)};`), '}'];
  assert.ok(extractSignature(wide, 0).length <= 480);
  // The body runs past what was read.
  assert.equal(extractSignature(['struct Point {', '    x: f64,', '    y: f64,'], 0), 'struct Point { x: f64; y: f64; … }');
});

test('the call or literal the cursor is inside of, when it was opened further up', () => {
  const call = '\t\torder, err := c.queries.CreateOrder(ctx, gen.CreateOrderParams{';
  assert.deepEqual(enclosingOpener([call], '\t\t\t'), { linesUp: 1, character: call.length - 1 });
  assert.deepEqual(enclosingOpener([call, '\t\t\tKind: in.Kind,', '\t\t\tTier: pick(a, b),'], '\t\t\tCurrency: '), {
    linesUp: 3,
    character: call.length - 1,
  });
  assert.deepEqual(enclosingOpener(['  const total = computeTotal('], '    order.items,'), { linesUp: 1, character: 28 });
  assert.deepEqual(enclosingOpener(['const options: ReportOptions = {'], '  '), { linesUp: 1, character: 31 });
  assert.deepEqual(enclosingOpener(['  return {'], '    '), { linesUp: 1, character: 9 });
  // Opened on the cursor's own line: nothing to add.
  assert.equal(enclosingOpener([call], '\t\t\tSource: pgtype.Text{String: '), undefined);
  // A block of code is not a value being filled in.
  assert.equal(enclosingOpener(['  if (ready) {'], '    '), undefined);
  assert.equal(enclosingOpener(['func (c *core) open(ctx context.Context) (gen.Order, error) {'], '\t'), undefined);
  assert.equal(enclosingOpener(['  items.forEach((item) => {'], '    '), undefined);
  assert.equal(enclosingOpener(['export class Store {'], '  '), undefined);
  // Closed again before the cursor, or nothing open at all.
  assert.equal(enclosingOpener(['  run({', '    a: 1,', '  });'], '  '), undefined);
  assert.equal(enclosingOpener([], '  '), undefined);
});

test('identifiers: up to three, closest to the cursor first, with their columns', () => {
  const line = '  const total = computeTotal(order.items, taxRate, ';
  assert.deepEqual(pickIdentifiers(line), [
    { name: 'taxRate', character: line.indexOf('taxRate') },
    { name: 'items', character: line.indexOf('items') },
    { name: 'order', character: line.indexOf('order') },
  ]);
  assert.deepEqual(
    pickIdentifiers(line, 5).map((use) => use.name),
    ['taxRate', 'items', 'order', 'computeTotal', 'total'],
  );
});

test('identifiers: keywords, short names, repeats, strings and comments are skipped', () => {
  assert.deepEqual(pickIdentifiers('    return await this.db.'), []);
  assert.deepEqual(
    pickIdentifiers('  if (user && user.isAdmin) return user.').map((use) => use.name),
    ['user', 'isAdmin'],
  );
  assert.deepEqual(pickIdentifiers('  log("fetching orders for customer")').map((use) => use.name), ['log']);
  assert.deepEqual(pickIdentifiers('  // call computeTotal with the order'), []);
  assert.deepEqual(pickIdentifiers('x = compute(a, b)  # then reload cache').map((use) => use.name), ['compute']);
  assert.deepEqual(pickIdentifiers(''), []);
});

test('signature: one line, without the body', () => {
  assert.equal(
    extractSignature(['export function computeTotal(items: number[], taxRate: number): number {', '  return 0;', '}'], 0),
    'export function computeTotal(items: number[], taxRate: number): number',
  );
  assert.equal(extractSignature(['  async list(filters: OrderFilters = {}): Promise<Order[]> {'], 0), 'async list(filters: OrderFilters = {}): Promise<Order[]>');
  assert.equal(extractSignature(['const add = (a: number, b: number) => {'], 0), 'const add = (a: number, b: number) =>');
  assert.equal(extractSignature(['def compute_total(items, tax_rate=0.21):'], 0), 'def compute_total(items, tax_rate=0.21):');
  assert.equal(extractSignature(['export interface Order {'], 0), 'export interface Order');
  assert.equal(extractSignature(['const MAX = 3;'], 0), 'const MAX');
});

test('signature: values never travel, only the shape of the declaration', () => {
  // A secret in a file that no exclusion pattern covers.
  assert.equal(extractSignature(['export const API_KEY = "sk-live-0123456789abcdef0123456789";'], 0), 'export const API_KEY');
  assert.equal(extractSignature(["DB_PASSWORD = 'hunter2-but-longer'"], 0), 'DB_PASSWORD');
  assert.equal(extractSignature(['const RETRIES: number = 3;'], 0), 'const RETRIES: number');
  assert.equal(extractSignature(['export const config = {'], 0), 'export const config');
  assert.equal(extractSignature(['let enabled = true;'], 0), 'let enabled');
  // Functions keep their parameters; only long string literals inside them are blanked.
  assert.equal(extractSignature(['const add = (a: number, b: number) => {'], 0), 'const add = (a: number, b: number) =>');
  assert.equal(extractSignature(['export const handler = async (event: Event) => {'], 0), 'export const handler = async (event: Event) =>');
  assert.equal(extractSignature(['def connect(host, token="ghp_abcdefghijklmnopqrstuvwxyz0123456789"):'], 0), 'def connect(host, token="…"):');
  assert.equal(extractSignature(["function greet(name = 'World') {"], 0), "function greet(name = 'World')");
  assert.equal(extractSignature(['const client = createClient(process.env.URL, "a-very-long-inline-token-value");'], 0), 'const client = createClient(process.env.URL, "…");');
});

test('signature: parameters spread over several lines are joined', () => {
  const lines = ['export function createOrder(', '  customer: Customer,', '  items: OrderItem[],', '): Promise<Order> {', '  // body'];
  assert.equal(extractSignature(lines, 0), 'export function createOrder( customer: Customer, items: OrderItem[], ): Promise<Order>');
  // Never more than a few lines, and never an endless line.
  const endless = ['function f(', ...Array.from({ length: 50 }, (_, i) => `  arg${i}: string,`)];
  assert.ok(extractSignature(endless, 0).split(',').length <= 5);
  assert.ok(extractSignature(['const data = "' + 'x'.repeat(1000) + '";'], 0).length <= 240);
  assert.equal(extractSignature([], 0), '');
});

test('format: one line per symbol with its file, deduplicated, at most three, within 400 tokens', () => {
  const symbols = [
    { path: 'src/lib/totals.ts', signature: 'export function computeTotal(items: number[]): number' },
    { path: 'src/lib/totals.ts', signature: 'export function computeTotal(items: number[]): number' },
    { path: 'src/types.ts', signature: 'export interface Order' },
    { path: 'src/a.ts', signature: 'export const a = 1;' },
    { path: 'src/b.ts', signature: 'export const b = 2;' },
    { path: 'src/empty.ts', signature: '   ' },
  ];
  assert.deepEqual(formatSymbols(symbols, 2.7), [
    'export function computeTotal(items: number[]): number  // src/lib/totals.ts',
    'export interface Order  // src/types.ts',
    'export const a = 1;  // src/a.ts',
  ]);
  const long = Array.from({ length: 3 }, (_, i) => ({ path: `src/f${i}.ts`, signature: `function f${i}(${'x'.repeat(230)})` }));
  const lines = formatSymbols(long, 2.7, 100);
  assert.ok(lines.join('\n').length <= 100 * 2.7);
  assert.deepEqual(formatSymbols([], 2.7), []);
});

test('prompt: the symbols block sits between the examples and the file', () => {
  const built = buildPrompt({
    path: 'src/report.ts',
    languageId: 'typescript',
    prefix: 'const total = computeTotal(',
    suffix: '',
    symbols: ['export function computeTotal(items: number[]): number  // src/lib/totals.ts'],
    limits: { ...DEFAULT_LIMITS, targetTokens: 900, charsPerToken: 2.7 },
  });
  assert.equal(built.symbolsUsed, 1);
  assert.ok(
    built.text.startsWith(
      '<symbols>\nexport function computeTotal(items: number[]): number  // src/lib/totals.ts\n</symbols>\n\n<file path="src/report.ts"',
    ),
  );
});
