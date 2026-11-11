import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LruCache, Typeahead, completionKey } from '../../src/completion/cache';

test('LRU: stores, returns and evicts the least recently used entry', () => {
  const cache = new LruCache<string>(3, 1000, () => 0);
  cache.set('a', '1');
  cache.set('b', '2');
  cache.set('c', '3');
  assert.equal(cache.get('a'), '1'); // "a" is now the most recent
  cache.set('d', '4');
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), '1');
  assert.equal(cache.get('c'), '3');
  assert.equal(cache.get('d'), '4');
  assert.equal(cache.size, 3);
});

test('LRU: entries expire after the TTL', () => {
  let now = 0;
  const cache = new LruCache<string>(10, 5 * 60_000, () => now);
  cache.set('k', 'v');
  now = 5 * 60_000 - 1;
  assert.equal(cache.get('k'), 'v');
  now = 5 * 60_000;
  assert.equal(cache.get('k'), undefined);
  assert.equal(cache.size, 0);
});

test('LRU: an empty suggestion is a cacheable answer, distinct from a miss', () => {
  const cache = new LruCache<string>();
  cache.set('k', '');
  assert.equal(cache.get('k'), '');
  assert.equal(cache.get('other'), undefined);
});

test('LRU: defaults are 200 entries', () => {
  const cache = new LruCache<number>();
  for (let i = 0; i < 250; i++) cache.set(`k${i}`, i);
  assert.equal(cache.size, 200);
  assert.equal(cache.get('k49'), undefined);
  assert.equal(cache.get('k50'), 50);
});

test('key: depends on the path and on what surrounds the cursor only', () => {
  const far = 'x'.repeat(2000);
  const near = 'const total = items.reduce(';
  const key = completionKey('a.ts', far + near, ')' + far);
  // Text further than 500 characters before / 200 after the cursor does not matter.
  assert.equal(completionKey('a.ts', 'y'.repeat(2000) + 'x'.repeat(500 - near.length) + near, ')' + 'x'.repeat(199) + 'zzz'), key);
  assert.notEqual(completionKey('b.ts', far + near, ')' + far), key);
  assert.notEqual(completionKey('a.ts', far + near + ' ', ')' + far), key);
  assert.notEqual(completionKey('a.ts', far + near, ']' + far), key);
  // Prefix and suffix are not interchangeable.
  assert.notEqual(completionKey('a.ts', 'ab', 'c'), completionKey('a.ts', 'a', 'bc'));
});

function reader(document: string) {
  return (start: number, end: number): string => document.slice(Math.max(0, start), end);
}

test('typeahead: typing the start of the suggestion serves the rest locally', () => {
  const typeahead = new Typeahead();
  const before = 'function add(a, b) {\n  return ';
  typeahead.remember('doc', before.length, reader(before), 'a + b;', 7);

  // Same position: the whole suggestion again.
  assert.deepEqual(typeahead.match('doc', before.length, reader(before)), { rest: 'a + b;', typed: '', id: 7 });
  // "a +" typed.
  const typed = before + 'a +';
  assert.deepEqual(typeahead.match('doc', typed.length, reader(typed)), { rest: ' b;', typed: 'a +', id: 7 });
  assert.equal(typeahead.currentId, 7);
});

test('typeahead: no match once the user diverges, finishes it, or goes elsewhere', () => {
  const typeahead = new Typeahead();
  const before = 'return ';
  typeahead.remember('doc', before.length, reader(before), 'a + b;', 1);

  const diverged = before + 'a -';
  assert.equal(typeahead.match('doc', diverged.length, reader(diverged)), null);
  // All of it typed (or accepted): a match with nothing left, so the caller can tell it apart.
  const complete = before + 'a + b;';
  assert.deepEqual(typeahead.match('doc', complete.length, reader(complete)), { rest: '', typed: 'a + b;', id: 1 });
  const beyond = complete + '\n';
  assert.equal(typeahead.match('doc', beyond.length, reader(beyond)), null);
  assert.equal(typeahead.match('other-doc', before.length + 1, reader(before + 'a')), null);
  // Cursor moved back before the anchor.
  assert.equal(typeahead.match('doc', 3, reader(before)), null);
});

test('typeahead: an edit before the anchor invalidates it', () => {
  const typeahead = new Typeahead();
  const before = 'const x = 1;\nreturn ';
  typeahead.remember('doc', before.length, reader(before), 'x + 1;', 1);
  // Same length, different content right before the anchor.
  const edited = 'const y = 1;\nreturn x';
  assert.equal(typeahead.match('doc', edited.length, reader(edited)), null);
});

test('typeahead: multi-line suggestions continue across the line break', () => {
  const typeahead = new Typeahead();
  const before = 'if (x) {';
  typeahead.remember('doc', before.length, reader(before), '\n  foo();\n}', 2);
  const typed = before + '\n  fo';
  assert.deepEqual(typeahead.match('doc', typed.length, reader(typed)), { rest: 'o();\n}', typed: '\n  fo', id: 2 });
});

test('typeahead: works in CRLF documents, where a line break is two characters', () => {
  const typeahead = new Typeahead();
  // The reader normalises line endings, as the provider's does; offsets are raw document offsets.
  const crlfReader = (document: string) => (start: number, end: number): string =>
    document.slice(Math.max(0, start), end).replace(/\r\n/g, '\n');
  const before = 'function f() {\r\n  if (x) {';
  typeahead.remember('doc', before.length, crlfReader(before), '\n    foo();\n  }', 3);
  const typed = before + '\r\n    fo';
  assert.deepEqual(typeahead.match('doc', typed.length, crlfReader(typed)), {
    rest: 'o();\n  }',
    typed: '\n    fo',
    id: 3,
  });
});

test('typeahead: clear forgets the suggestion', () => {
  const typeahead = new Typeahead();
  typeahead.remember('doc', 0, reader(''), 'abc', 1);
  typeahead.clear();
  assert.equal(typeahead.match('doc', 0, reader('')), null);
  assert.equal(typeahead.currentId, null);
});
