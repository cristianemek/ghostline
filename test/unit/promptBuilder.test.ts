import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_LIMITS,
  buildPrompt,
  takePrefix,
  takeSuffix,
  type PromptInput,
  type PromptLimits,
} from '../../src/completion/promptBuilder';

const LIMITS: PromptLimits = { ...DEFAULT_LIMITS, fileTargetTokens: 1000, charsPerToken: 2.4 };

function lines(count: number, width = 30, tag = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${tag} ${String(i).padStart(4, '0')} `.padEnd(width, 'x')).join('\n');
}

function input(overrides: Partial<PromptInput> = {}): PromptInput {
  return {
    path: 'src/foo.ts',
    languageId: 'typescript',
    prefix: 'const a = 1;\nconst b = ',
    suffix: ';\nconsole.log(b);',
    limits: LIMITS,
    ...overrides,
  };
}

test('takePrefix keeps the last N lines, the current line included', () => {
  assert.equal(takePrefix('a\nb\nc', 2, 1000), 'b\nc');
  assert.equal(takePrefix('a\nb\nc', 1, 1000), 'c');
  assert.equal(takePrefix('a\nb\nc', 10, 1000), 'a\nb\nc');
  assert.equal(takePrefix('a\nb\n', 2, 1000), 'b\n');
  assert.equal(takePrefix('', 5, 1000), '');
});

test('takePrefix cuts on a line boundary when over the character budget', () => {
  assert.equal(takePrefix('first line\nsecond line\nthird', 10, 14), 'third');
  assert.equal(takePrefix('first line\nsecond line\nthird', 10, 17), 'second line\nthird');
  // A single line longer than the budget keeps its end (the part next to the cursor).
  assert.equal(takePrefix('x'.repeat(50) + 'END', 10, 5), 'xxEND');
});

test('takeSuffix keeps the rest of the line plus the next N lines', () => {
  assert.equal(takeSuffix('rest\nl1\nl2\nl3', 2, 1000), 'rest\nl1\nl2');
  assert.equal(takeSuffix('rest\nl1\nl2\nl3', 0, 1000), 'rest');
  assert.equal(takeSuffix('rest\nl1', 20, 1000), 'rest\nl1');
  assert.equal(takeSuffix('rest\nline one\nline two', 20, 15), 'rest\nline one');
  assert.equal(takeSuffix('', 20, 1000), '');
});

test('message layout matches the spec', () => {
  const built = buildPrompt(input());
  assert.equal(
    built.text,
    '<file path="src/foo.ts" language="typescript">\n' +
      '<prefix>const a = 1;\nconst b = </prefix><cursor/><suffix>;\nconsole.log(b);</suffix>\n' +
      '</file>',
  );
  assert.equal(built.prefix, 'const a = 1;\nconst b = ');
  assert.equal(built.suffix, ';\nconsole.log(b);');
  assert.equal(built.chars, built.text.length);
  assert.equal(built.estimatedTokens, Math.ceil(built.text.length / 2.4));
});

test('the stable block comes first and is byte-identical between requests', () => {
  const style = 'Use single quotes. 2 spaces. No semicolons.';
  const a = buildPrompt(input({ styleProfile: style, prefix: 'one\n', suffix: '' }));
  const b = buildPrompt(input({ styleProfile: style, prefix: 'something else entirely\n', suffix: '\nmore', path: 'b.ts' }));
  const stable = `<style>\n${style}\n</style>\n`;
  assert.ok(a.text.startsWith(stable));
  assert.ok(b.text.startsWith(stable));
  // Order: style, examples, symbols, file.
  const full = buildPrompt(
    input({
      styleProfile: style,
      examples: [{ before: 'const x = 1;', accepted: 'const y = 2;' }],
      symbols: ['function parse(input: string): Ast'],
    }),
  );
  const order = ['<style>', '<examples>', '<symbols>', '<file '].map((tag) => full.text.indexOf(tag));
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  assert.ok(order.every((index) => index >= 0));
  assert.equal(full.examplesUsed, 1);
  assert.equal(full.symbolsUsed, 1);
});

test('file context stays within the token target: the prefix is trimmed from the top', () => {
  const prefix = lines(400, 50);
  const suffix = '\n' + lines(100, 50, 'after');
  const built = buildPrompt(input({ prefix, suffix }));
  const fileChars = built.prefix.length + built.suffix.length;
  assert.ok(fileChars <= 1000 * 2.4, `file context ${fileChars} chars`);
  // The lines next to the cursor survive; the top of the window is what goes.
  assert.ok(built.prefix.endsWith(prefix.slice(-200)));
  assert.ok(!built.prefix.includes('line 0000'));
  // Whole lines only.
  assert.ok(built.prefix.startsWith('line '));
  // The suffix gets a quarter of the budget at most.
  assert.ok(built.suffix.length <= 1000 * 2.4 * 0.25);
  assert.ok(built.suffix.length > 0);
});

test('line and character caps apply even with a generous budget', () => {
  const generous: PromptLimits = { ...LIMITS, fileTargetTokens: 100_000, hardTokens: 100_000 };
  const built = buildPrompt(input({ prefix: lines(500, 20), suffix: '\n' + lines(500, 20), limits: generous }));
  assert.ok(built.prefix.split('\n').length <= 60);
  assert.ok(built.prefix.length <= 3000);
  assert.ok(built.suffix.split('\n').length <= 21);
  assert.ok(built.suffix.length <= 1000);
});

test('a short suffix leaves its share of the budget to the prefix', () => {
  const prefix = lines(400, 50);
  const withSuffix = buildPrompt(input({ prefix, suffix: '\n' + lines(100, 50) }));
  const atEndOfFile = buildPrompt(input({ prefix, suffix: '' }));
  assert.ok(atEndOfFile.prefix.length > withSuffix.prefix.length);
});

test('hard limit: optional blocks go first, then the suffix, then the prefix', () => {
  const tight: PromptLimits = { ...LIMITS, fileTargetTokens: 1000, hardTokens: 600 };
  const examples = [
    { before: lines(5, 60), accepted: 'x'.repeat(200) },
    { before: lines(5, 60), accepted: 'y'.repeat(200) },
  ];
  const symbols = ['function a(): void', 'function b(): void', 'function c(): void'];
  const built = buildPrompt(input({ prefix: lines(200, 50), suffix: '\n' + lines(50, 50), examples, symbols, limits: tight }));
  assert.ok(built.estimatedTokens <= 600, `estimated ${built.estimatedTokens}`);
  assert.equal(built.symbolsUsed, 0);
  assert.equal(built.examplesUsed, 0);
  assert.ok(built.prefix.length > 0);
  assert.ok(built.text.includes('<cursor/>'));
});

test('hard limit holds for every size of input', () => {
  for (const hardTokens of [50, 200, 800, 2500]) {
    for (const count of [1, 10, 100, 1000]) {
      const built = buildPrompt(
        input({
          prefix: lines(count, 80),
          suffix: '\n' + lines(count, 80),
          styleProfile: 'short style',
          limits: { ...LIMITS, hardTokens },
        }),
      );
      // The fixed wrapper (tags, path, style) is the floor; beyond it the limit must hold.
      const floor = Math.ceil(buildPrompt(input({ prefix: '', suffix: '', styleProfile: 'short style' })).chars / 2.4) + 1;
      assert.ok(built.estimatedTokens <= Math.max(hardTokens, floor), `hard ${hardTokens}, ${count} lines → ${built.estimatedTokens}`);
    }
  }
});

test('one enormous line does not blow the budget', () => {
  const built = buildPrompt(input({ prefix: 'x'.repeat(200_000), suffix: 'y'.repeat(200_000) }));
  assert.ok(built.estimatedTokens <= LIMITS.hardTokens);
  assert.ok(built.prefix.length <= 3000);
  assert.ok(built.suffix.length <= 1000);
});

test('path and language cannot break out of their attributes', () => {
  const built = buildPrompt(input({ path: 'we"ird\npath.ts', languageId: 'type"script' }));
  assert.ok(built.text.startsWith('<file path="we ird path.ts" language="type script">'));
});
