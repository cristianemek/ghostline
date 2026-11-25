import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bareInsertion,
  insertionFromLine,
  insertionSoFar,
  isAside,
  noteFrom,
  postprocess,
  shouldStopEarly,
  type IndentStyle,
} from '../../src/completion/postprocess';
import { closesBlock } from '../../src/completion/trigger';
import { changedLines, isWorkInProgress, lineSpans, locateChange, parseChange, type Change } from '../../src/edit/fix';

const TABS: IndentStyle = { insertSpaces: false, tabSize: 4 };
const SPACES: IndentStyle = { insertSpaces: true, tabSize: 2 };
const go = (raw: string, prefix: string, suffix = ''): string => postprocess({ raw, prefix, suffix, maxLines: 6, indent: TABS, languageId: 'go' });
const ts = (raw: string, prefix: string, suffix = ''): string =>
  postprocess({ raw, prefix, suffix, maxLines: 6, indent: SPACES, languageId: 'typescript' });

test('the next statement, written without its line break, goes on the next line', () => {
  const loop = '\tfor _, o := range orders {\n\t\ttotal += o.Amount\n\t}';
  assert.equal(go(loop, 'func sum() {\n\tb.WriteString("header")', '\n\treturn b.String()\n}'), `\n${loop}`);
  assert.equal(go('\tif i < 0 {\n\t\treturn 0\n\t}', 'func find() int {\n\t})', '\n}'), '\n\tif i < 0 {\n\t\treturn 0\n\t}');
  assert.equal(ts('  return total;', 'function f() {\n  const total = sum(items);', '\n}'), '\n  return total;');
  assert.equal(postprocess({ raw: '    return 1', prefix: 'def one():', suffix: '', maxLines: 6, indent: { insertSpaces: true, tabSize: 4 }, languageId: 'python' }), '\n    return 1');
  assert.equal(go('        order.ID,', '\treturn card{\n\t\tID:', '\n\t}'), '        order.ID,');
  assert.equal(ts('  value', 'const x =', ''), '  value');
  assert.equal(go('\t.Trim()', '\tname := raw', '.Lower()'), '.Trim()');
});

test('what the model says to itself never reaches the editor', () => {
  const explanation = 'The loop variable is `o` but the body uses `order`; the fix is on the line already in the prefix, and the cursor sits after it.';
  assert.equal(go(explanation, '\tfor _, o := range orders {\n\t\tfmt.Println(order.Title)', '\n\t}'), '');
  assert.equal(go("i >= 0 && ok, false\n\nWait, that's wrong; correct output:\n\nif i < 0 {\n\t\treturn 0\n\t}", '\treturn ', '\n}'), '');
  assert.equal(go('order.ID)</s>\n\nWait, I must output only code.', '\tlog.Println("order", ', ')'), 'order.ID');
  assert.equal(go('.ID</prefix>\n\nWait, I', '\t\tID:        order', ',\n\t}'), '.ID');
  assert.equal(go('total<|im_end|>', '\treturn ', ''), 'total');
  assert.equal(ts('SELECT name FROM users WHERE active ORDER BY name', 'const sql = `', '`;'), 'SELECT name FROM users WHERE active ORDER BY name');
  assert.equal(
    postprocess({ raw: '</s>', prefix: '<p><s>old', suffix: '</p>', maxLines: 6, indent: SPACES, languageId: 'html' }),
    '</s>',
  );
});

test('a block that ends right after the line limit keeps the line that closes it', () => {
  const head = 'for _, o := range orders {\n\t\tif o.Paid {\n\t\t\tcontinue\n\t\t}\n\t\ttotal += o.Amount\n\t\tcount++';
  assert.equal(go(`${head}\n\t}`, 'func sum() {\n\t', '\n}'), `${head}\n\t}`);
  assert.equal(go(`${head}\n\t\tlast = o\n\t}`, 'func sum() {\n\t', '\n}'), head);
  assert.equal(go('a := 1\n\tb := 2\n\tc := 3\n\td := 4\n\te := 5\n\tf := 6\n\t}', 'func sum() {\n\t', ''), 'a := 1\n\tb := 2\n\tc := 3\n\td := 4\n\te := 5\n\tf := 6');
});

test('a closing bracket that is already after the cursor is not written again', () => {
  assert.equal(go('order.Deadline) {', '\tif status == pending && time.Now().After(', ')'), 'order.Deadline');
  assert.equal(ts('a) + f(b', 'const x = foo(', ');'), 'a) + f(b');
  assert.equal(ts('a, b)', 'foo(', ')'), 'a, b');
});

test('mid-line: spacing the model tidied on the way does not lose the insertion', () => {
  const before = 'func report(title, unit string,orders';
  const after = ' now time.Time) string {';
  assert.equal(insertionFromLine('func report(title, unit string, orders []Order, now time.Time) string {', before, after), ' []Order,');
  assert.equal(insertionFromLine('func report(title, unit string, orders now time.Time) string {', before, after), '');
  assert.equal(insertionSoFar('func report(title, unit string, ord', before), '');
  assert.equal(insertionSoFar('func report(title, unit string, orders []Or', before), ' []Or');
  assert.equal(insertionSoFar('func other(', before), null);
});

test('mid-line: a bare insertion is taken when the model did not write the line', () => {
  assert.equal(bareInsertion('.ID</prefix>\n\nWait, I', '\t\tID:        order', ','), '.ID');
  assert.equal(bareInsertion('= await ', '  const paid ', "listOrders('paid');"), '= await');
  assert.equal(bareInsertion('let x = foo(1, 2)', 'const x = foo(', ')'), '');
  assert.equal(bareInsertion("const paid = await listOrders('paid');", '  let paid ', "listOrders('paid');"), '');
  assert.equal(bareInsertion('<none/>', 'a', 'b'), '');
});

test('notes: what the model says should change, when it says so instead of completing', () => {
  const note = 'La variable del bucle es `o`, pero el cuerpo usa `order`.';
  assert.equal(noteFrom(`<note>${note}</note>`, '\tx := 1', 'go'), note);
  assert.equal(noteFrom(`<note>\n  ${note}\n</note>\n`, '\tx := 1', 'go'), note);
  assert.equal(noteFrom(`<note>${'muy largo '.repeat(40)}</note>`, '\tx := 1', 'go')?.length, 180);
  assert.equal(
    noteFrom('The loop variable is `o` but the body uses `order`; the fix is on the line already in the prefix.', '\t\tfmt.Println(order.Title)', 'go'),
    'The loop variable is `o` but the body uses `order`',
  );
  assert.equal(noteFrom("I don't know the generated query names, so I'll guess.", '\t}', 'go'), undefined);
  assert.equal(noteFrom('return total', '\t', 'go'), undefined);
  assert.equal(noteFrom('<none/>', '\t', 'go'), undefined);
  assert.equal(noteFrom('<note></note>', '\t', 'go'), undefined);
  assert.equal(noteFrom('The `total` already includes the tax of the whole order.', '// ', 'go'), undefined);
  assert.equal(noteFrom('The `total` already includes the tax of the whole order.', '', 'markdown'), undefined);
  assert.equal(go(`<note>${note}</note>`, '\tx := 1', '\n}'), '');

  const streaming = { maxLines: 6, prefix: '\tfor _, o := range orders {\n\t\tfmt.Println(order.Title)', languageId: 'go' };
  assert.equal(shouldStopEarly('<note>La variable del bucle es `o`, pero el cuerpo usa `order` y eso', streaming), false);
  assert.equal(shouldStopEarly(`<note>${note}</note>`, streaming), true);
  assert.equal(shouldStopEarly(`<note>${'sin fin '.repeat(90)}`, streaming), true);
});

test('changes: the lines the model wants replaced are found near the cursor and rewritten in place', () => {
  const file = [
    'func summary(orders []Order) string {',
    '\tvar b strings.Builder',
    '',
    '\tfor _, o := range orders {',
    '\t\tfmt.Println(order.Title)',
    '\t}',
    '',
    '\treturn b.String()',
    '}',
  ];
  const lineAt = (line: number): string => file[line] as string;
  const answer = '<change><old>\t\tfmt.Println(order.Title)</old><new>\t\tfmt.Println(o.Title)</new></change>';
  const change = parseChange(answer);
  assert.deepEqual(change, { oldLines: ['\t\tfmt.Println(order.Title)'], newLines: ['\t\tfmt.Println(o.Title)'] });
  assert.deepEqual(locateChange(lineAt, file.length, 4, change?.oldLines ?? []), { startLine: 4, endLine: 4 });
  assert.deepEqual(changedLines([file[4] as string], change as Change), ['\t\tfmt.Println(o.Title)']);

  const loose = parseChange('<change>\n<old>\nfmt.Println(order.Title)\n</old>\n<new>\nfmt.Println(o.Title)\n</new>\n</change>') as Change;
  assert.deepEqual(locateChange(lineAt, file.length, 5, loose.oldLines), { startLine: 4, endLine: 4 });
  assert.deepEqual(changedLines([file[4] as string], loose), ['\t\tfmt.Println(o.Title)']);

  const moved = parseChange('<change><old>\tfor _, o := range orders {\n\t\tfmt.Println(order.Title)\n\t}\n\n\treturn b.String()</old><new>\tfor _, o := range orders {\n\t\tfmt.Println(o.Title)\n\t}\n\treturn b.String()</new></change>') as Change;
  assert.deepEqual(locateChange(lineAt, file.length, 7, moved.oldLines), { startLine: 3, endLine: 7 });
  assert.deepEqual(changedLines(file.slice(3, 8), moved), ['\tfor _, o := range orders {', '\t\tfmt.Println(o.Title)', '\t}', '\treturn b.String()']);

  const twice = ['\tx := load()', '\tsave(x)', '\tx := load()', '\tsave(x)'];
  assert.deepEqual(locateChange((line) => twice[line] as string, twice.length, 3, ['save(x)']), { startLine: 3, endLine: 3 });
  assert.deepEqual(locateChange((line) => twice[line] as string, twice.length, 0, ['save(x)']), { startLine: 1, endLine: 1 });

  assert.equal(locateChange(lineAt, file.length, 4, ['\t\tfmt.Println(item.Title)']), undefined);
  assert.equal(locateChange(lineAt, file.length, 4, ['}']), undefined);
  assert.equal(changedLines([file[4] as string], { oldLines: [file[4] as string], newLines: ['\t\tfmt.Println(o.Title'] }), undefined);
  assert.equal(changedLines([file[4] as string], { oldLines: [file[4] as string], newLines: [`${file[4]}  `] }), undefined);
  assert.deepEqual(changedLines([file[6] as string, file[7] as string], { oldLines: ['', '\treturn b.String()'], newLines: [] }), []);

  assert.equal(parseChange('return total'), undefined);
  assert.equal(parseChange('<change><old></old><new>x</new></change>'), undefined);
  assert.equal(parseChange('<change><old>a := 1</old><new>a := 1</new></change>'), undefined);
  assert.equal(parseChange(`<change><old>${'x\n'.repeat(13)}</old><new>y</new></change>`), undefined);
  assert.equal(parseChange('<change><old>a := 1</old><new>a := 2'), undefined);

  const streaming = { maxLines: 6, prefix: '\t\tfmt.Println(order.Title)', languageId: 'go' };
  assert.equal(shouldStopEarly('<change><old>\t\tfmt.Println(order.Title)</old><new>\t\tfmt.Println(o.Tit', streaming), false);
  assert.equal(shouldStopEarly(`${answer}\nand some more`, streaming), true);
  assert.equal(go(answer, '\t\tfmt.Println(order.Title)', '\n\t}'), '');
  assert.equal(go('<change><old>\t\tfmt.Println(order.Title)</old><new>\t\tfmt.Println(o.Tit', '\t\tfmt.Println(order.Title)', '\n\t}'), '');
  assert.equal(isAside('<note>La nota</note>', 'xml'), false);
  assert.equal(
    postprocess({ raw: '<note>Call the supplier</note>', prefix: '<notes>\n  ', suffix: '\n</notes>', maxLines: 6, indent: SPACES, languageId: 'xml' }),
    '<note>Call the supplier</note>',
  );
});

test('changes inside one line are marked where they are', () => {
  const before = '\t\tfmt.Println(order.Title, order.Status)';
  assert.deepEqual(lineSpans(before, '\t\tfmt.Println(o.Title, o.Status)'), [
    { start: 14, end: 19, text: 'o' },
    { start: 27, end: 32, text: 'o' },
  ]);
  assert.deepEqual(lineSpans('\torder, err := find(id)', '\torder, err := find(id, false)'), [{ start: 22, end: 22, text: ', false' }]);
  assert.deepEqual(lineSpans('  const total = sum(items, tax);', '  const total = sum(items);'), [{ start: 25, end: 30, text: '' }]);
  assert.equal(lineSpans('\ttotal += price', '\t\ttotal += price'), undefined);
  assert.equal(lineSpans('a b c d e f g h', 'b a d c f e h g'), undefined);
  assert.equal(lineSpans('same', 'same'), undefined);
});

test('nothing is asked right after a line that only closes a block', () => {
  assert.equal(closesBlock('\t}', ''), true);
  assert.equal(closesBlock('\t})', '  '), true);
  assert.equal(closesBlock('];', ''), true);
  assert.equal(closesBlock('\t} else', ''), false);
  assert.equal(closesBlock('\t}', ')'), false);
  assert.equal(closesBlock('\tfoo()', ''), false);
  assert.equal(closesBlock('', ''), false);
});

test('corrections leave alone the errors of code that is still being written', () => {
  for (const message of [
    'declared and not used: items',
    '"os" imported and not used',
    "'total' is declared but its value is never read.",
    "'x' is assigned a value but never used.",
    'missing return',
  ]) {
    assert.equal(isWorkInProgress(message), true, message);
  }
  for (const message of ['undefined: order', 'not enough arguments in call to report', "Property 'nme' does not exist on type 'Order'."]) {
    assert.equal(isWorkInProgress(message), false, message);
  }
});
