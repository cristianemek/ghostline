// Integration tests: the real WorkerPool/CliWorker against test/fake-claude.js. No tokens are spent.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import type { InitInfo, RateLimitInfo } from '../../src/cli/streamParser';
import { WorkerPool, type PoolConfig } from '../../src/cli/workerPool';

const FAKE_CLI = join(process.cwd(), 'test', 'fake-claude.js');
const scratch = mkdtempSync(join(tmpdir(), 'ghostline-test-'));
after(async () => {
  // Retired workers exit once their stdin is closed, which needs the event loop: a synchronous
  // retry loop here would keep them alive, and on Windows a live child locks its cwd.
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    console.error(`could not remove ${scratch}: ${error instanceof Error ? error.message : String(error)}`);
  }
});

interface Harness {
  pool: WorkerPool;
  inits: InitInfo[];
  rateLimits: RateLimitInfo[];
  logs: string[];
}

function createPool(t: TestContext, fakeEnv: Record<string, string> = {}, overrides: Partial<PoolConfig> = {}): Harness {
  const inits: InitInfo[] = [];
  const rateLimits: RateLimitInfo[] = [];
  const logs: string[] = [];
  const pool = new WorkerPool(
    {
      command: process.execPath,
      commandPrefixArgs: [FAKE_CLI],
      model: 'haiku',
      effort: 'low',
      systemPromptFile: join(scratch, 'system prompt.txt'),
      cwd: scratch,
      mode: 'single-use',
      recycleEvery: 8,
      requestTimeoutMs: 5000,
      standbyMaxIdleMs: 60_000,
      promptCache: false,
      env: { ...process.env, ...fakeEnv },
      ...overrides,
    },
    {
      onInit: (info) => inits.push(info),
      onRateLimit: (info) => rateLimits.push(info),
      log: (message) => logs.push(message),
    },
  );
  t.after(() => pool.dispose());
  return { pool, inits, rateLimits, logs };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('single-use: returns the completion with usage and timings', async (t) => {
  const { pool, inits, rateLimits } = createPool(t, { FAKE_TEXT: 'return a + b;', FAKE_INPUT_TOKENS: '1500' });
  pool.warm();
  const outcome = await pool.request('<file>…</file>');
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.text, 'return a + b;');
  assert.equal(outcome.usage.inputTokens, 1500);
  assert.equal(outcome.usage.outputTokens, 12);
  assert.equal(outcome.usagePartial, false);
  assert.equal(outcome.costUsd, 0.0002);
  assert.ok(outcome.firstTokenMs !== null && outcome.firstTokenMs >= 0);
  assert.ok(outcome.totalMs >= outcome.firstTokenMs);
  assert.ok(outcome.waitForWorkerMs < 100);
  assert.equal(inits.length, 1);
  assert.equal(inits[0]?.apiKeySource, 'none');
  assert.equal(rateLimits.length, 1);
  assert.equal(rateLimits[0]?.windows.seven_day?.utilization, 0.5);
});

test('single-use: every request gets a brand-new process and a standby replaces the one taken', async (t) => {
  const { pool } = createPool(t, { FAKE_TEXT: 'turn {turn}' });
  pool.warm();
  assert.equal(pool.spawnCount, 1);
  const first = await pool.request('one');
  const second = await pool.request('two');
  const third = await pool.request('three');
  // A fresh conversation every time: the fake CLI would answer "turn 2" on a reused process.
  assert.deepEqual([first.text, second.text, third.text], ['turn 1', 'turn 1', 'turn 1']);
  // warm + one replacement per request.
  assert.equal(pool.spawnCount, 4);
});

test('single-use: works without warming first (cold start)', async (t) => {
  const { pool } = createPool(t);
  const outcome = await pool.request('cold');
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.text, 'fake completion');
});

test('launches the CLI with the hardened flags, our cwd and prompt caching off', async (t) => {
  const argsFile = join(scratch, 'args.json');
  const { pool } = createPool(t, { FAKE_ARGS_FILE: argsFile });
  await pool.request('x');
  const recorded = JSON.parse(readFileSync(argsFile, 'utf8')) as {
    argv: string[];
    cwd: string;
    env: Record<string, string | null>;
  };
  const { argv } = recorded;
  const valueOf = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
  for (const flag of [
    '-p',
    '--verbose',
    '--include-partial-messages',
    '--safe-mode',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ]) {
    assert.ok(argv.includes(flag), `missing ${flag}`);
  }
  assert.equal(valueOf('--input-format'), 'stream-json');
  assert.equal(valueOf('--output-format'), 'stream-json');
  assert.equal(valueOf('--model'), 'haiku');
  assert.equal(valueOf('--effort'), 'low');
  // The empty string must survive as its own argument: that is what disables every tool.
  assert.equal(valueOf('--tools'), '');
  assert.equal(valueOf('--setting-sources'), 'project');
  // A path with a space arrives intact because no shell is involved.
  assert.equal(valueOf('--system-prompt-file'), join(scratch, 'system prompt.txt'));
  assert.equal(recorded.cwd.toLowerCase(), scratch.toLowerCase());
  assert.equal(recorded.env.DISABLE_PROMPT_CACHING, '1');
  assert.equal(recorded.env.DISABLE_AUTOUPDATER, '1');
});

test('prompt caching can be left on', async (t) => {
  const argsFile = join(scratch, 'args-cache.json');
  const { pool } = createPool(t, { FAKE_ARGS_FILE: argsFile, DISABLE_PROMPT_CACHING: '1' }, { promptCache: true });
  await pool.request('x');
  const recorded = JSON.parse(readFileSync(argsFile, 'utf8')) as { env: Record<string, string | null> };
  assert.equal(recorded.env.DISABLE_PROMPT_CACHING, null);
});

test('persistent: one process serves several requests and is recycled every N', async (t) => {
  const { pool } = createPool(t, { FAKE_TEXT: 'turn {turn}' }, { mode: 'persistent', recycleEvery: 2 });
  pool.warm();
  const texts: string[] = [];
  for (let i = 0; i < 5; i++) texts.push((await pool.request(`request ${i}`)).text);
  assert.deepEqual(texts, ['turn 1', 'turn 2', 'turn 1', 'turn 2', 'turn 1']);
});

test('persistent: a cancelled request does not poison the next one', async (t) => {
  const { pool } = createPool(t, { FAKE_TEXT: 'turn {turn}', FAKE_DELAY_MS: '150' }, { mode: 'persistent' });
  pool.warm();
  const slow = pool.request('first');
  await sleep(30);
  const next = await pool.request('second');
  assert.equal((await slow).status, 'cancelled');
  assert.equal(next.status, 'ok');
  // Served by the promoted standby, not by the process that was killed mid-turn.
  assert.equal(next.text, 'turn 1');
});

test('timeout: the process is killed and no text is returned', async (t) => {
  const { pool } = createPool(t, { FAKE_MODE: 'hang' }, { requestTimeoutMs: 200 });
  const started = Date.now();
  const outcome = await pool.request('x');
  assert.equal(outcome.status, 'timeout');
  assert.equal(outcome.text, '');
  assert.ok(Date.now() - started < 2000);
});

test('cancellation through the AbortSignal', async (t) => {
  const { pool } = createPool(t, { FAKE_DELAY_MS: '2000' });
  pool.warm();
  const controller = new AbortController();
  const pending = pool.request('x', { signal: controller.signal });
  await sleep(50);
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.status, 'cancelled');
  assert.ok(outcome.totalMs < 1500);
});

test('an already aborted signal never reaches the CLI', async (t) => {
  const { pool } = createPool(t);
  const controller = new AbortController();
  controller.abort();
  const outcome = await pool.request('x', { signal: controller.signal });
  assert.equal(outcome.status, 'cancelled');
  assert.equal(pool.spawnCount, 0);
});

test('a new request cancels the one in flight', async (t) => {
  const { pool } = createPool(t, { FAKE_DELAY_MS: '300' });
  pool.warm();
  const first = pool.request('first');
  await sleep(20);
  const second = pool.request('second');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'cancelled');
  assert.equal(b.status, 'ok');
});

test('is_error results are reported as errors with the CLI message', async (t) => {
  const { pool } = createPool(t, { FAKE_MODE: 'error' });
  const outcome = await pool.request('x');
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.text, '');
  assert.match(outcome.errorMessage ?? '', /Invalid API key/);
});

test('a process that dies mid-request is an error that includes stderr', async (t) => {
  const { pool } = createPool(t, { FAKE_MODE: 'crash' });
  const outcome = await pool.request('x');
  assert.equal(outcome.status, 'error');
  assert.match(outcome.errorMessage ?? '', /boom/);
});

test('a CLI that cannot start does not cause a respawn loop', async (t) => {
  const { pool, logs } = createPool(t, { FAKE_MODE: 'crash-on-start' });
  pool.warm();
  await sleep(400);
  pool.warm(); // still backing off
  pool.warm();
  assert.equal(pool.spawnCount, 1);
  assert.ok(logs.some((line) => line.includes('cannot start')));
  const outcome = await pool.request('x');
  assert.equal(outcome.status, 'error');
});

test('a command that does not exist is an error, not an exception', async (t) => {
  const { pool } = createPool(t, {}, { command: join(scratch, 'no-such-binary.exe'), commandPrefixArgs: [] });
  const outcome = await pool.request('x');
  assert.equal(outcome.status, 'error');
  assert.match(outcome.errorMessage ?? '', /no se pudo lanzar|ya no está/);
});

test('unknown message types and non-JSON noise do not break a request', async (t) => {
  const { pool } = createPool(t, { FAKE_MODE: 'noisy', FAKE_TEXT: 'still fine' });
  const outcome = await pool.request('x');
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.text, 'still fine');
});

test('shouldStop cuts the answer short and still reports the input tokens', async (t) => {
  const text = 'line 1\nline 2\nline 3\nline 4\nline 5';
  const { pool } = createPool(t, { FAKE_TEXT: text, FAKE_CHUNKS: '5', FAKE_CHUNK_MS: '40', FAKE_INPUT_TOKENS: '900' });
  const outcome = await pool.request('x', { shouldStop: (soFar) => soFar.split('\n').length > 2 });
  assert.equal(outcome.status, 'ok');
  assert.equal(outcome.stoppedEarly, true);
  assert.ok(outcome.text.startsWith('line 1\nline 2'));
  assert.ok(outcome.text.length < text.length);
  assert.equal(outcome.usagePartial, true);
  assert.equal(outcome.usage.inputTokens, 900);
  assert.ok(outcome.usage.outputTokens > 0);
});

test('a cancelled request that already reached the model reports its input tokens', async (t) => {
  const { pool } = createPool(t, { FAKE_TEXT: 'abcdefghij', FAKE_CHUNKS: '10', FAKE_CHUNK_MS: '50', FAKE_INPUT_TOKENS: '700' });
  const controller = new AbortController();
  const pending = pool.request('x', { signal: controller.signal });
  await sleep(250);
  controller.abort();
  const outcome = await pending;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.text, '');
  assert.equal(outcome.usagePartial, true);
  assert.equal(outcome.usage.inputTokens, 700);
});

test('apiKeySource from system/init is surfaced', async (t) => {
  const { pool, inits } = createPool(t, { FAKE_API_KEY_SOURCE: 'ANTHROPIC_API_KEY' });
  await pool.request('x');
  assert.equal(inits[0]?.apiKeySource, 'ANTHROPIC_API_KEY');
});

test('an idle standby is retired and replaced on demand', async (t) => {
  const { pool, logs } = createPool(t, {}, { standbyMaxIdleMs: 100 });
  pool.warm();
  assert.equal(pool.spawnCount, 1);
  await sleep(350);
  // Retiring it is not a failure: no backoff, no log noise.
  assert.deepEqual(logs, []);
  pool.warm();
  assert.equal(pool.spawnCount, 2);
  const outcome = await pool.request('x');
  assert.equal(outcome.status, 'ok');
});

test('a working folder that was cleaned up behind our back is recreated', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ghostline-test-gone-'));
  rmdirSync(cwd);
  const { pool } = createPool(t, {}, { cwd });
  const outcome = await pool.request('x');
  assert.equal(outcome.status, 'ok');
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rm(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
  });
});

test('dispose: later requests are cancelled without spawning', async (t) => {
  const { pool } = createPool(t);
  pool.warm();
  pool.dispose();
  const outcome = await pool.request('x');
  assert.equal(outcome.status, 'cancelled');
  pool.warm();
  assert.equal(pool.spawnCount, 1);
});
