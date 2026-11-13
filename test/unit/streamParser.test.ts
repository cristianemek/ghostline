import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  NdjsonParser,
  toCliEvent,
  totalInputTokens,
  type CliEvent,
  type JsonObject,
} from '../../src/cli/streamParser';

const fixture = (name: string): Buffer => readFileSync(join(process.cwd(), 'test', 'fixtures', name));

function parseAll(chunks: Array<Buffer | string>): { events: CliEvent[]; objects: JsonObject[]; bad: number } {
  const objects: JsonObject[] = [];
  const parser = new NdjsonParser((obj) => objects.push(obj));
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return { objects, events: objects.map(toCliEvent), bad: parser.badLines };
}

function kinds(events: CliEvent[]): string[] {
  return events.map((event) => event.kind);
}

test('real capture: init, deltas and result are extracted, everything else is ignored', () => {
  const { events, bad } = parseAll([fixture('success-short.ndjson')]);
  assert.equal(bad, 0);

  const init = events.find((event) => event.kind === 'init');
  assert.ok(init && init.kind === 'init');
  assert.equal(init.model, 'claude-haiku-5-5');
  assert.deepEqual(init.tools, []);
  assert.deepEqual(init.mcpServers, []);
  assert.equal(init.apiKeySource, 'none');
  assert.equal(init.cliVersion, '2.1.322');

  const text = events.flatMap((event) => (event.kind === 'textDelta' ? [event.text] : [])).join('');
  assert.equal(text, 'a + b');

  const result = events.at(-1);
  assert.ok(result && result.kind === 'result');
  assert.equal(result.isError, false);
  assert.equal(result.text, 'a + b');
  assert.equal(result.usage.inputTokens, 2);
  assert.equal(result.usage.cacheWriteTokens, 2767);
  assert.equal(result.usage.cacheReadTokens, 0);
  assert.equal(result.usage.outputTokens, 5);
  assert.equal(result.usage.thinkingTokens, 0);
  assert.equal(totalInputTokens(result.usage), 2769);
  assert.ok(result.costUsd > 0);
  assert.ok(result.durationMs > 0);

  assert.ok(kinds(events).includes('unknown'));
});

test('real capture: message_start already carries the input tokens', () => {
  const { events } = parseAll([fixture('success-multiline.ndjson')]);
  const start = events.find((event) => event.kind === 'messageStart');
  assert.ok(start && start.kind === 'messageStart');
  assert.equal(start.usage.inputTokens, 1926);
  const result = events.at(-1);
  assert.ok(result && result.kind === 'result');
  assert.equal(result.text.split('\n').length, 3);
});

test('real capture: rate_limit_event exposes the subscription windows', () => {
  const { events } = parseAll([fixture('success-short.ndjson')]);
  const rate = events.find((event) => event.kind === 'rateLimit');
  assert.ok(rate && rate.kind === 'rateLimit');
  assert.deepEqual(Object.keys(rate.windows).sort(), ['five_hour', 'seven_day']);
  assert.equal(typeof rate.windows.seven_day?.utilization, 'number');
});

test('errors are detected through is_error even when subtype says success', () => {
  const { events } = parseAll([fixture('error-unrecognized-model.ndjson')]);
  const result = events.at(-1);
  assert.ok(result && result.kind === 'result');
  assert.equal(result.subtype, 'success');
  assert.equal(result.isError, true);
  assert.match(result.text, /issue with the selected model/);
});

test('lines split at arbitrary byte positions parse the same', () => {
  const data = fixture('success-multiline.ndjson');
  const whole = parseAll([data]);
  for (const size of [1, 7, 64, 1000]) {
    const chunks: Buffer[] = [];
    for (let i = 0; i < data.length; i += size) chunks.push(data.subarray(i, i + size));
    const split = parseAll(chunks);
    assert.deepEqual(split.objects, whole.objects, `chunk size ${size}`);
  }
});

test('a multi-byte character split across chunks is not corrupted', () => {
  const line = Buffer.from(JSON.stringify({ type: 'result', result: 'añadir → ñandú 🚀', is_error: false }) + '\n');
  const cut = line.indexOf(Buffer.from('ñ')) + 1;
  const { events } = parseAll([line.subarray(0, cut), line.subarray(cut)]);
  const result = events[0];
  assert.ok(result && result.kind === 'result');
  assert.equal(result.text, 'añadir → ñandú 🚀');
});

test('unknown types, blank lines, CRLF and garbage are tolerated', () => {
  const input = [
    '{"type":"active_goal","goal":null}\r\n',
    '\r\n',
    'not json at all\n',
    '[1,2,3]\n',
    '"just a string"\n',
    '{"type":"autocompact_state"}\n',
    '{"no_type":true}\n',
    '{"type":"system","subtype":"status","status":"requesting"}\n',
    '{"type":"result","subtype":"success","is_error":false,"result":"ok"}',
  ];
  const { events, bad } = parseAll(input);
  assert.equal(bad, 3);
  assert.deepEqual(kinds(events), ['unknown', 'unknown', 'unknown', 'unknown', 'result']);
});

test('missing or malformed fields fall back to safe defaults', () => {
  const result = toCliEvent({ type: 'result', usage: { input_tokens: 'many', output_tokens: null } });
  assert.ok(result.kind === 'result');
  assert.equal(result.isError, false);
  assert.equal(result.text, '');
  assert.deepEqual(result.usage, {
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

  const init = toCliEvent({ type: 'system', subtype: 'init' });
  assert.ok(init.kind === 'init');
  assert.deepEqual(init.tools, []);
  assert.equal(init.apiKeySource, '');

  assert.equal(toCliEvent({ type: 'stream_event' }).kind, 'unknown');
  assert.equal(toCliEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta' } } }).kind, 'unknown');
});

test('an absurdly long line is dropped instead of buffered', () => {
  const objects: JsonObject[] = [];
  const parser = new NdjsonParser((obj) => objects.push(obj));
  const chunk = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 6; i++) parser.push(chunk);
  parser.push('tail of the long line\n{"type":"result","result":"after"}\n');
  parser.end();
  assert.equal(objects.length, 1);
  assert.equal(parser.badLines, 1);
});
