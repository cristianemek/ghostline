import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasUnmatchedCloser, postprocess, stripCodeFences, type IndentStyle } from '../../src/completion/postprocess';

const SPACES_2: IndentStyle = { insertSpaces: true, tabSize: 2 };
const SPACES_4: IndentStyle = { insertSpaces: true, tabSize: 4 };
const TABS: IndentStyle = { insertSpaces: false, tabSize: 4 };

function run(raw: string, prefix: string, suffix = '', options: { maxLines?: number; indent?: IndentStyle } = {}): string {
  return postprocess({ raw, prefix, suffix, maxLines: options.maxLines ?? 6, indent: options.indent ?? SPACES_2 });
}

test('plain completion passes through', () => {
  assert.equal(run('a + b', 'function add(a, b) {\n  return ', '\n}'), 'a + b');
});

test('trailing whitespace and CRLF are normalised', () => {
  assert.equal(run('a + b;  \r\n\r\n', 'return '), 'a + b;');
  assert.equal(run('foo();\r\nbar();', '  '), 'foo();\n  bar();');
});

test('code fences are removed', () => {
  assert.equal(run('```ts\nconst x = 1;\n```', ''), 'const x = 1;');
  assert.equal(run('Here is the code:\n```\nconst x = 1;\n```\nHope it helps', ''), 'const x = 1;');
  assert.equal(run('```typescript\nconst x = 1;', ''), 'const x = 1;');
  assert.equal(run('`a + b`', 'return '), 'a + b');
  assert.equal(stripCodeFences('no fences here'), 'no fences here');
});

test('answers that are not code are dropped', () => {
  for (const raw of [
    'OK',
    'Okay.',
    '(empty)',
    '<none/>',
    'No completion',
    "Here's the completion you asked for:",
    'I cannot complete this code without more context.',
    "I don't have enough context.",
    'The code is already complete.',
    'There is nothing to add here.',
    'Sure! const x = 1',
    'No completion needed.',
    '   ',
    '',
  ]) {
    assert.equal(run(raw, 'const x = 1;\n'), '', JSON.stringify(raw));
  }
});

test('things that look like chatter but are real code survive', () => {
  // `ok` is an everyday Go identifier.
  assert.equal(run('ok {', 'if v, ok := m[k]; '), 'ok {');
  assert.equal(run('null', 'return '), 'null');
  assert.equal(run('none', 'display: '), 'none');
  assert.equal(run('""', 'const s = '), '""');
  // …but a bare empty string on its own line is the model saying "empty".
  assert.equal(run('""', 'const s = 1;\n'), '');
  // Prose is the right completion inside a comment.
  assert.equal(run('Here is where the header is parsed', '// '), 'Here is where the header is parsed');
  assert.equal(run('I cannot be null here', '  # '), 'I cannot be null here');
});

test('the echoed cursor marker is removed', () => {
  assert.equal(run('a + b<cursor/>', 'return '), 'a + b');
});

test('leading whitespace: blank line keeps the existing indentation only', () => {
  assert.equal(run('    return x;', 'function f() {\n    ', '\n}', { indent: SPACES_4 }), 'return x;');
  assert.equal(run('\n\n  return x;', 'function f() {\n  '), 'return x;');
});

test('leading whitespace: a needed space is kept, a doubled one is not', () => {
  assert.equal(run(' 5;', 'const x ='), ' 5;');
  assert.equal(run(' 5;', 'const x = '), '5;');
});

test('leading newline: the completion continues on a new line, once', () => {
  assert.equal(run('\n\n\n  return 1;\n}', 'function f() {'), '\n  return 1;\n}');
});

test('prefix overlap: whole line restated', () => {
  assert.equal(run('const total = items.length;', '  const total = '), 'items.length;');
  assert.equal(run('  const total = items.length;', '  const total ='), ' items.length;');
  assert.equal(run('return a + b;', '  return '), 'a + b;');
});

test('prefix overlap: partial word or last token restated', () => {
  assert.equal(run('foo(bar)', 'const x = fo'), 'o(bar)');
  assert.equal(run('if (ready) {', 'i'), 'f (ready) {');
  assert.equal(run('bar()', '  foo.ba'), 'r()');
  assert.equal(run('a + b', 'x = a'), ' + b');
  assert.equal(run('i++)', 'for (let i = 0; i < n; i'), '++)');
});

test('prefix overlap: a lone closer is a second closer, not a repeat', () => {
  assert.equal(run(');', 'console.log(foo(1)'), ');');
  assert.equal(run('}', 'const a = {b: {c: 1}'), '}');
  assert.equal(run(')', 'call(other(x)'), ')');
});

test('prefix overlap: no false positive in the middle of a word', () => {
  // "t" is the end of "const" and the start of "t x": not a restatement.
  assert.equal(run('total = 1;', 'const '), 'total = 1;');
  assert.equal(run('t x = 1;', 'cons'), 't x = 1;');
});

test('a first line that repeats the previous line is dropped', () => {
  assert.equal(run('const first = 1;\nconst second = 2;', 'const first = 1;\n'), 'const second = 2;');
  assert.equal(run("import { a } from './a';", "import { a } from './a';\n"), '');
  // Short repeated lines ("}", "break;") are legitimate.
  assert.equal(run('}', '  }\n'), '}');
});

test('suffix overlap: same line', () => {
  assert.equal(run('a, b)', 'foo(', ')'), 'a, b');
  assert.equal(run('a, b);', 'foo(', ');\nnext();'), 'a, b');
  assert.equal(run('hello"', 'const s = "', '";'), 'hello');
  // A balanced call keeps its own closing paren.
  assert.equal(run('bar(a)', 'foo(', ')'), 'bar(a)');
  assert.equal(run('items[0]', 'use(', ')'), 'items[0]');
});

test('suffix overlap: identical to what follows the cursor', () => {
  assert.equal(run(');', 'foo(a', ');'), '');
  assert.equal(run('b)', 'foo(a, ', 'b)'), '');
});

test('suffix overlap: following lines repeated at the end of the completion', () => {
  const prefix = 'function f() {\n  const x = 1;\n  ';
  const suffix = '\n  return x;\n}\n';
  assert.equal(run('log(x);\n  return x;\n}', prefix, suffix), 'log(x);');
  // The whole completion already exists below: nothing to show.
  assert.equal(run('return x;\n}', prefix, suffix), '');
});

test('suffix overlap: a closing brace that belongs to the enclosing block is removed', () => {
  assert.equal(run('return 1;\n}', 'function f() {\n  ', '\n}\n'), 'return 1;');
  assert.equal(run('\n}', 'function f() {\n  return 1;', '\n}\n'), '');
});

test('suffix overlap: a block that closes itself keeps its brace', () => {
  const prefix = 'function f() {\n  ';
  const suffix = '\n}\n';
  assert.equal(run('if (a) {\n  b();\n}', prefix, suffix), 'if (a) {\n    b();\n  }');
});

test('suffix overlap: braces at different depths are different braces', () => {
  // The inner block still needs its "}" even though the next line is also "}".
  const prefix = 'if (a) {\n  if (b) {\n    foo();\n  ';
  assert.equal(run('}', prefix, '\n}\n'), '}');
});

test('indentation: following lines are re-based on the current line', () => {
  // Measured with the real model: first line off by one space, the rest one level too deep.
  const prefix = '    for (const order of orders) {\n      ';
  const raw =
    '       const list = groups.get(order.status) ?? [];\n        list.push(order);\n        groups.set(order.status, list);';
  assert.equal(
    run(raw, prefix, '\n    }\n'),
    'const list = groups.get(order.status) ?? [];\n      list.push(order);\n      groups.set(order.status, list);',
  );
});

test('indentation: relative structure is preserved whatever base the model used', () => {
  const expected = 'if (x) {\n      foo();\n    }';
  // Absolute, relative to zero, and with a different unit: same result.
  assert.equal(run('if (x) {\n      foo();\n    }', 'f() {\n    '), expected);
  assert.equal(run('if (x) {\n  foo();\n}', 'f() {\n    '), expected);
  assert.equal(run('if (x) {\n        foo();\n    }', 'f() {\n    '), expected);
});

test('indentation: block opened on the current line', () => {
  assert.equal(run('\nreturn 1;', 'function f() {'), '\n  return 1;');
  assert.equal(run('\nreturn 1', 'def f():', '', { indent: SPACES_4 }), '\n    return 1');
  // An unclosed paren on the current line also means "one level deeper".
  assert.equal(run('a,\n    b\n);', 'call('), 'a,\n  b\n);');
  assert.equal(run('a,\n  b\n);', '  call('), 'a,\n    b\n  );');
});

test('indentation: tabs', () => {
  assert.equal(run('if (x) {\n    foo();\n}', '\tfunction f() {\n\t\t', '', { indent: TABS }), 'if (x) {\n\t\t\tfoo();\n\t\t}');
});

test('indentation: a comment ending in a colon does not open a block', () => {
  assert.equal(run('Steps:\n// 1. parse', '  // '), 'Steps:\n  // 1. parse');
});

test('maxLines', () => {
  const raw = ['a();', 'b();', 'c();', 'd();', 'e();'].join('\n');
  assert.equal(run(raw, '', '', { maxLines: 2 }), 'a();\nb();');
  assert.equal(run(raw, '', '', { maxLines: 6 }), raw);
  // The line break that starts a new line does not count as a suggested line.
  assert.equal(run('\na();\nb();\nc();', 'x();', '', { maxLines: 2 }), '\na();\nb();');
  // No dangling blank line after truncation.
  assert.equal(run('a();\n\nb();', '', '', { maxLines: 2 }), 'a();');
});

test('hasUnmatchedCloser', () => {
  assert.equal(hasUnmatchedCloser('foo(a, b)'), false);
  assert.equal(hasUnmatchedCloser('a, b)'), true);
  assert.equal(hasUnmatchedCloser('if (a) {\n  b();\n}'), false);
  assert.equal(hasUnmatchedCloser('return 1;\n}'), true);
  assert.equal(hasUnmatchedCloser('x = ")"'), false);
  assert.equal(hasUnmatchedCloser("don't()"), false);
  assert.equal(hasUnmatchedCloser('a[0]]'), true);
});
