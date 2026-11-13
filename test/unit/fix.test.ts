import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITS } from '../../src/completion/promptBuilder';
import { buildFixPrompt, diffLines, fixRegion, hunkPreview, parseFix } from '../../src/edit/fix';

const file = [
  'func (c *core) finishOrder(ctx context.Context, itemID pgtype.UUID, content json.RawMessage, cause error) {',
  '\tstatus := gen.OrderStatusCompleted',
  '',
  '\tswitch expression {',
  '\tcase condition:',
  '',
  '\t}',
  '}',
];
const lineAt = (line: number): string => file[line] as string;
const problems = [
  { line: 3, message: 'undefined: expression' },
  { line: 4, message: 'undefined: condition' },
];

test('fix: the region is the statement the errors are in, closed where its brackets close', () => {
  assert.deepEqual(fixRegion(lineAt, file.length, problems, 3), { startLine: 3, endLine: 6 });
  assert.deepEqual(fixRegion(lineAt, file.length, problems, 1), { startLine: 3, endLine: 6 });
  assert.equal(fixRegion(lineAt, file.length, [{ line: 40, message: 'x' }], 3), undefined);
  assert.equal(fixRegion(lineAt, file.length, [], 3), undefined);
  const call = ['\trows, err := c.queries.ListOrderItems(ctx, orderID, nil)', '\tif err != nil {', '\t}'];
  assert.deepEqual(fixRegion((line) => call[line] as string, call.length, [{ line: 0, message: 'too many arguments' }], 0), { startLine: 0, endLine: 0 });
  const text = ['\tlog("open ( never closed") // {', '\tnext()'];
  assert.deepEqual(fixRegion((line) => text[line] as string, text.length, [{ line: 0, message: 'x' }], 0), { startLine: 0, endLine: 0 });
});

test('fix: nothing when what would have to be rewritten is too long or cannot be cut out cleanly', () => {
  const long = ['func big() {', ...Array.from({ length: 30 }, (_, i) => `\tstep${i}()`), '}'];
  assert.equal(fixRegion((line) => long[line] as string, long.length, [{ line: 0, message: 'x' }], 0), undefined);
  const stray = ['\t})', '\tnext()'];
  assert.equal(fixRegion((line) => stray[line] as string, stray.length, [{ line: 0, message: 'unexpected )' }], 0), undefined);
  const spread = Array.from({ length: 20 }, (_, i) => `\tline${i}()`);
  const at = (line: number): string => spread[line] as string;
  assert.equal(fixRegion(at, spread.length, [{ line: 0, message: 'x' }, { line: 12, message: 'z' }], 6), undefined);
  assert.deepEqual(fixRegion(at, spread.length, [{ line: 0, message: 'x' }, { line: 6, message: 'y' }, { line: 13, message: 'far' }], 6), { startLine: 0, endLine: 6 });
});

test('fix: the prompt marks the region where the cursor would be and lists the errors by line of the region', () => {
  const built = buildFixPrompt({
    path: 'api/core.go',
    languageId: 'go',
    before: file.slice(0, 3).join('\n') + '\n',
    region: file.slice(3, 7).join('\n'),
    after: '\n' + file.slice(7).join('\n'),
    problems: [...problems, { line: 4, message: 'undefined: condition' }, { line: 3, message: 'second line\nof a long message' }],
    regionStartLine: 3,
    limits: { ...DEFAULT_LIMITS, targetTokens: 900, charsPerToken: 2.7 },
  });
  assert.equal(
    built.text,
    '<file path="api/core.go" language="go">\n' +
      '<prefix>func (c *core) finishOrder(ctx context.Context, itemID pgtype.UUID, content json.RawMessage, cause error) {\n' +
      '\tstatus := gen.OrderStatusCompleted\n\n</prefix><region>\n' +
      '\tswitch expression {\n\tcase condition:\n\n\t}\n' +
      '</region><suffix>\n}</suffix>\n</file>\n' +
      '<fix>\nThe compiler reports, inside <region>:\n- line 1: undefined: expression\n- line 2: undefined: condition\n- line 1: second line\n</fix>\n' +
      "Write the 4 lines of <region> again, from the first line's first character to the end, with these errors fixed.",
  );
  assert.equal(built.chars, built.text.length);
});

test('fix: the answer becomes the new lines of the region, or nothing when it is not a correction', () => {
  const original = file.slice(3, 7);
  const fixed = ['\tswitch {', '\tcase cause != nil:', '\t\tstatus = gen.OrderStatusFailed', '\t}'];
  assert.deepEqual(parseFix(fixed.join('\n'), original, 'go'), fixed);
  assert.deepEqual(parseFix('```go\n' + fixed.join('\n') + '\n```', original, 'go'), fixed);
  assert.deepEqual(parseFix('<region>\n' + fixed.join('\n') + '\n</region>', original, 'go'), fixed);
  assert.deepEqual(parseFix(fixed.map((line) => line.slice(1) + '  ').join('\n'), original, 'go'), fixed);
  assert.equal(parseFix(original.join('\n'), original, 'go'), undefined);
  assert.equal(parseFix('<none/>', original, 'go'), undefined);
  assert.equal(parseFix('I cannot tell what the switch should test for here.', original, 'go'), undefined);
  assert.equal(parseFix('\tswitch {\n\tcase ... no, wait — the status is set above', original, 'go'), undefined);
  assert.equal(parseFix(Array.from({ length: 30 }, (_, i) => `\tstep${i}()`).join('\n'), original, 'go'), undefined);
  assert.equal(parseFix('', original, 'go'), undefined);
  assert.equal(parseFix('\tswitch {\n\tcase cause != nil:', original, 'go'), undefined);
  const call = ['\trows, err := c.queries.ListOrderItems(ctx, orderID, nil)'];
  assert.equal(parseFix('ctx, orderID, nil)', call, 'go'), undefined);
  assert.equal(parseFix('ListOrderItems(ctx, orderID)', call, 'go'), undefined);
  assert.equal(parseFix('ld, err := c.queries.ListOrderItems(ctx, orderID)', call, 'go'), undefined);
  assert.deepEqual(parseFix('rows, err := c.queries.ListOrderItems(ctx, orderID)', call, 'go'), ['\trows, err := c.queries.ListOrderItems(ctx, orderID)']);
  assert.deepEqual(parseFix('\treturn total', ['\tretrun total'], 'go'), ['\treturn total']);
});

test('fix: the stretches that change, and how each one is shown', () => {
  const oldLines = ['\tswitch expression {', '\tcase condition:', '', '\t}'];
  const newLines = ['\tswitch {', '\tcase cause != nil:', '\t\tstatus = gen.OrderStatusFailed', '\t}'];
  const hunks = diffLines(oldLines, newLines);
  assert.deepEqual(hunks, [{ oldStart: 0, oldCount: 3, newLines: ['\tswitch {', '\tcase cause != nil:', '\t\tstatus = gen.OrderStatusFailed'] }]);
  assert.equal(hunkPreview(hunks[0] as (typeof hunks)[number]), 'switch { ⏎ case cause != nil: ⏎ status = gen.OrderStatusFailed');

  assert.deepEqual(diffLines(['a()', 'b(x, y, nil)', 'c()'], ['a()', 'b(x, y)', 'c()']), [{ oldStart: 1, oldCount: 1, newLines: ['b(x, y)'] }]);
  assert.deepEqual(diffLines(['a()', 'c()'], ['a()', 'b()', 'c()']), [{ oldStart: 1, oldCount: 0, newLines: ['b()'] }]);
  const removal = diffLines(['a()', 'b()', 'c()'], ['a()', 'c()']);
  assert.deepEqual(removal, [{ oldStart: 1, oldCount: 1, newLines: [] }]);
  assert.equal(hunkPreview(removal[0] as (typeof removal)[number]), 'se elimina');
  assert.deepEqual(diffLines(['same'], ['same']), []);
  assert.ok(hunkPreview({ oldStart: 0, oldCount: 1, newLines: ['x'.repeat(400)] }).length <= 160);
});
