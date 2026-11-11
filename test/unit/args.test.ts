import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCliArgs, buildCliEnv, userMessageLine } from '../../src/cli/args';
import { formatRequestLine } from '../../src/usage/requestLog';
import { dayRow, statusText, summaryLine, tooltipLines, usesApiKey, type SessionInfo } from '../../src/usage/report';
import { emptyDay } from '../../src/usage/usageTracker';

test('arguments: every flag from the spec, plus --setting-sources project', () => {
  const args = buildCliArgs({ model: 'haiku', effort: 'low', systemPromptFile: 'C:\\ext\\system prompt.txt' });
  assert.deepEqual(args, [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', 'haiku',
    '--effort', 'low',
    '--tools', '',
    '--safe-mode',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--setting-sources', 'project',
    '--system-prompt-file', 'C:\\ext\\system prompt.txt',
  ]);
});

test('environment: inherited, without prompt caching or auto-update, and detached from any parent session', () => {
  const base = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    CLAUDE_CONFIG_DIR: '/custom/config',
    CLAUDE_CODE_OAUTH_TOKEN: 'keep-me',
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_CODE_MESSAGING_SOCKET: 'pipe',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
  };
  const env = buildCliEnv(base, { promptCache: false });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/me');
  // Authentication and configuration variables are the user's: untouched.
  assert.equal(env.CLAUDE_CONFIG_DIR, '/custom/config');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'keep-me');
  assert.equal(env.DISABLE_PROMPT_CACHING, '1');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  for (const name of Object.keys(base).filter((key) => /^CLAUDECODE$|SESSION|MESSAGING|ENTRYPOINT/.test(key))) {
    assert.equal(env[name], undefined, name);
  }
  // The caller's environment object is not modified.
  assert.equal(base.CLAUDECODE, '1');
  assert.equal(buildCliEnv({ DISABLE_PROMPT_CACHING: '1' }, { promptCache: true }).DISABLE_PROMPT_CACHING, undefined);
});

test('input line: one JSON object per line, whatever the prompt contains', () => {
  const line = userMessageLine('line 1\nline 2 "quoted" \u2028 end');
  assert.ok(line.endsWith('\n'));
  assert.equal(line.indexOf('\n'), line.length - 1);
  assert.deepEqual(JSON.parse(line), {
    type: 'user',
    message: { role: 'user', content: 'line 1\nline 2 "quoted" \u2028 end' },
  });
});

const session: SessionInfo = {
  triggerMode: 'auto',
  workerMode: 'single-use',
  paused: false,
  limitReached: false,
  dailyLimit: 1500,
  model: 'claude-haiku-5-5',
  apiKeySource: 'none',
};

function busyDay() {
  return {
    ...emptyDay('2026-11-11'),
    requests: 123,
    inputTokens: 170_000,
    outputTokens: 4_000,
    cacheReadTokens: 6_000,
    shown: 100,
    accepted: 34,
    costUsd: 0.0312,
  };
}

test('status bar text follows the spec format', () => {
  assert.equal(statusText(busyDay(), session), 'ghostline 123 · 180k tok · 34% ✓');
  assert.equal(statusText(emptyDay('2026-11-11'), session), 'ghostline 0 · 0 tok · – ✓');
  assert.match(statusText(busyDay(), { ...session, paused: true }), /^\$\(debug-pause\) ghostline 123/);
  assert.match(statusText(busyDay(), { ...session, triggerMode: 'manual' }), /^ghostline \(manual\) 123/);
  assert.match(statusText(busyDay(), { ...session, limitReached: true }), /^\$\(circle-slash\)/);
  assert.match(statusText(busyDay(), { ...session, cliError: 'no claude' }), /sin CLI/);
});

test('tooltip: breakdown, latency, model, apiKeySource and warnings', () => {
  const text = tooltipLines(busyDay(), { p50: 912.4, p95: 1480 }, 1890, {
    ...session,
    rateLimit: {
      status: 'allowed',
      windows: {
        five_hour: { utilization: 0.07, resetsAt: 0, status: 'allowed' },
        seven_day: { utilization: 0.86, resetsAt: 0, status: 'allowed_warning' },
      },
    },
  }).join('\n');
  assert.match(text, /entrada 170k · salida 4\.0k/);
  assert.match(text, /34 aceptadas \(34%\)/);
  assert.match(text, /p50 912 ms · p95 1480 ms/);
  assert.match(text, /claude-haiku-5-5 · apiKeySource: none \(suscripción\)/);
  assert.match(text, /5 h 7% · 7 días 86%/);
  assert.match(text, /mediana\): 1\.9k tokens/);
  assert.doesNotMatch(text, /API key/);

  const withKey = tooltipLines(busyDay(), {}, undefined, { ...session, apiKeySource: 'ANTHROPIC_API_KEY' }).join('\n');
  assert.match(withKey, /usa una API key \(`ANTHROPIC_API_KEY`\)/);
  const limited = tooltipLines(busyDay(), {}, undefined, { ...session, limitReached: true }).join('\n');
  assert.match(limited, /Límite diario alcanzado \(1500\)/);
});

test('usesApiKey: only "none" (or nothing yet) means subscription', () => {
  assert.equal(usesApiKey('none'), false);
  assert.equal(usesApiKey(undefined), false);
  assert.equal(usesApiKey(''), false);
  assert.equal(usesApiKey('ANTHROPIC_API_KEY'), true);
  assert.equal(usesApiKey('apiKeyHelper'), true);
});

test('7-day rows', () => {
  const row = dayRow(busyDay(), { p50: 900, p95: 1500 }, 1900);
  assert.equal(row.summary, '123 peticiones · 180k tok · 34% ✓');
  assert.match(row.detail, /p50 900 ms · p95 1500 ms/);
  assert.match(row.detail, /0,0312 \$ equiv\./);
});

test('log summary: p50/p95 and input median, with a warning when the median is slow', () => {
  const fast = summaryLine(busyDay(), { p50: 868, p95: 1713 }, 1933);
  assert.match(fast, /123 peticiones · latencia p50 868 ms \/ p95 1713 ms · entrada mediana 1933 tokens/);
  assert.doesNotMatch(fast, /AVISO/);
  const slow = summaryLine(busyDay(), { p50: 1574, p95: 3379 }, 1911);
  assert.match(slow, /AVISO: la p50 supera 1,5 s/);
  assert.match(slow, /ghostline\.triggerMode/);
});

test('request log line has waits, tokens and the outcome, and never the prompt', () => {
  const line = formatRequestLine(
    {
      id: 42,
      time: new Date(2026, 10, 11, 9, 5, 7),
      languageId: 'typescript',
      context: 'new-line',
      manual: false,
      waitForWorkerMs: 0.4,
      firstTokenMs: 640.2,
      totalMs: 912.6,
      usage: { inputTokens: 1926, outputTokens: 41, thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      usagePartial: false,
    },
    '3 líneas → aceptada',
  );
  assert.equal(
    line,
    '[09:05:07] #42 typescript new-line · espera 0 ms · primer token 640 ms · total 913 ms · ' +
      'tokens: entrada 1926, salida 41, razonamiento 0, caché 0/0 · 3 líneas → aceptada',
  );
});
