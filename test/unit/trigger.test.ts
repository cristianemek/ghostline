import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TypingRate,
  agreesWithTyping,
  classifyContext,
  cursorAllowsAuto,
  debounceDelay,
  eagerDelay,
  wait,
} from '../../src/completion/trigger';

test('auto mode fires at the end of the line or before closing characters only', () => {
  for (const rest of ['', '   ', ')', ');', '})', ' ]', '"', "'", '`', '"); ', '\t}']) {
    assert.equal(cursorAllowsAuto(rest), true, JSON.stringify(rest));
  }
  for (const rest of ['foo', ' + b', ') + 1', ', b)', '.length', '= 1;', '{', '(']) {
    assert.equal(cursorAllowsAuto(rest), false, JSON.stringify(rest));
  }
});

test('context classification', () => {
  assert.equal(classifyContext(''), 'new-line');
  assert.equal(classifyContext('    '), 'new-line');
  assert.equal(classifyContext('  user.'), 'after-dot');
  assert.equal(classifyContext('  user?.'), 'after-dot');
  assert.equal(classifyContext('  foo('), 'after-paren');
  assert.equal(classifyContext('  foo( '), 'after-paren');
  assert.equal(classifyContext('  const x = '), 'end-of-line');
  assert.equal(classifyContext('  return'), 'end-of-line');
});

test('a request in the air stays useful while the typing agrees with its answer', () => {
  // Nothing answered yet, or nothing typed yet: no disagreement.
  assert.equal(agreesWithTyping('', 'res', false), true);
  assert.equal(agreesWithTyping('result = 1;', '', false), true);
  // As far as both go, same text.
  assert.equal(agreesWithTyping('result = 1;', 'res', false), true);
  assert.equal(agreesWithTyping('res', 'result = ', false), true);
  assert.equal(agreesWithTyping('result = 1;', 'rex', false), false);
  assert.equal(agreesWithTyping('re', 'data', false), false);
  // Leading whitespace of the answer is dropped on a blank line, kept elsewhere.
  assert.equal(agreesWithTyping('    return x;', 'ret', true), true);
  assert.equal(agreesWithTyping(' 5;', '5', false), false);
  assert.equal(agreesWithTyping(' 5;', ' 5', false), true);
  // A markdown wrapper cannot be judged yet.
  assert.equal(agreesWithTyping('```ts\nreturn x;', 'zzz', false), true);
  assert.equal(agreesWithTyping('a\r\nb', 'a\nb', false), true);
});

test('typing rate: more than 6 keystrokes per second over the last 2 seconds is fast', () => {
  const rate = new TypingRate();
  // 12 keystrokes in 2 s is exactly 6/s: not fast yet.
  for (let i = 0; i < 12; i++) rate.record(1000 + i * 100);
  assert.equal(rate.isFast(2200), false);
  rate.record(2250);
  assert.equal(rate.isFast(2250), true);
  // After a pause the old keystrokes fall out of the window.
  assert.equal(rate.isFast(4300), false);
});

test('typing rate: slow typing is never fast', () => {
  const rate = new TypingRate();
  for (let i = 0; i < 50; i++) rate.record(i * 300);
  assert.equal(rate.isFast(50 * 300), false);
});

test('the short wait adapts to the typing rhythm', () => {
  // No recent typing to go by: the configured short wait.
  assert.equal(eagerDelay(350, 120, undefined), 120);
  // A key every 110 ms: 176 ms without one is a pause.
  assert.equal(eagerDelay(350, 120, 110), 176);
  // A slow typist: never longer than the normal debounce.
  assert.equal(eagerDelay(350, 120, 300), 350);
  // A very fast one: never shorter than the configured short wait.
  assert.equal(eagerDelay(350, 120, 40), 120);
  // Setting both the same switches the distinction off.
  assert.equal(eagerDelay(350, 350, 110), 350);
  assert.equal(eagerDelay(200, 350, undefined), 200);

  const rate = new TypingRate();
  assert.equal(rate.medianGap(0), undefined);
  for (const stamp of [1000, 1100, 1210, 1300, 1420, 1900]) rate.record(stamp);
  assert.equal(rate.medianGap(1900), 110);
  // Old keystrokes fall out of the window.
  assert.equal(rate.medianGap(5000), undefined);
});

test('debounce is longer while typing fast', () => {
  assert.equal(debounceDelay(350, false), 350);
  assert.ok(debounceDelay(350, true) > 350);
  assert.equal(debounceDelay(0, false), 0);
});

test('wait resolves true after the delay and false as soon as it is aborted', async () => {
  assert.equal(await wait(10, new AbortController().signal), true);

  const controller = new AbortController();
  const started = Date.now();
  const pending = wait(5000, controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  assert.ok(Date.now() - started < 1000);

  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await wait(5000, aborted.signal), false);
});
