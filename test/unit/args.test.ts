import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCliArgs, buildCliEnv, endpointOverride, userMessageLine } from '../../src/cli/args';
import { formatRequestLine } from '../../src/usage/requestLog';
import {
  METER_WIDTH,
  TOOLTIP_COMMANDS,
  dayRow,
  meterStops,
  plainStatus,
  sessionStart,
  statusText,
  summaryLine,
  tooltipMarkdown,
  usesApiKey,
  type SessionInfo,
} from '../../src/usage/report';
import { emptyDay } from '../../src/usage/usageTracker';

test('the server the requests go to is reported when the environment points away from Anthropic, host only', () => {
  assert.equal(endpointOverride({}), undefined);
  assert.equal(endpointOverride({ ANTHROPIC_BASE_URL: '  ' }), undefined);
  assert.equal(endpointOverride({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), undefined);
  assert.equal(endpointOverride({ ANTHROPIC_BASE_URL: 'https://gateway.example.com/v1' }), 'gateway.example.com');
  assert.equal(endpointOverride({ ANTHROPIC_BASE_URL: 'http://user:hunter2@10.0.0.7:8080/x' }), '10.0.0.7:8080');
  assert.equal(endpointOverride({ ANTHROPIC_BASE_URL: 'not a url' }), 'una dirección no reconocible');
});

test('arguments: no tools, no MCP, no commands, no saved session, and settings only from our own empty folder', () => {
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
  assert.equal(env.CLAUDE_CONFIG_DIR, '/custom/config');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'keep-me');
  assert.equal(env.DISABLE_PROMPT_CACHING, '1');
  assert.equal(env.DISABLE_AUTOUPDATER, '1');
  for (const name of Object.keys(base).filter((key) => /^CLAUDECODE$|SESSION|MESSAGING|ENTRYPOINT/.test(key))) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(base.CLAUDECODE, '1');
  assert.equal(buildCliEnv({ DISABLE_PROMPT_CACHING: '1' }, { promptCache: true }).DISABLE_PROMPT_CACHING, undefined);
  assert.equal(buildCliEnv({}, { promptCache: true }).CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL, '5m');
  assert.equal(buildCliEnv({ CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: '1h' }, { promptCache: true }).CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL, '5m');
  assert.equal(buildCliEnv({ CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL: '1h' }, { promptCache: false }).CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL, undefined);
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
  paused: false,
  limitReached: false,
  dailyLimit: 1500,
  apiKeySource: 'none',
  sessionSpentUsd: 0.0312,
  sessionBudgetUsd: 80,
};

const rateLimit: NonNullable<SessionInfo['rateLimit']> = {
  status: 'allowed',
  windows: {
    five_hour: { utilization: 0.59, resetsAt: 0, status: 'allowed' },
    seven_day: { utilization: 0.93, resetsAt: 0, status: 'allowed_warning' },
  },
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

test('status bar text: share of ghostline’s own daily cap · share of a Claude session ghostline has used', () => {
  assert.equal(statusText(busyDay(), { ...session, rateLimit }), '$(ghostline-ghost) 8% · Claude 0,04%');
  assert.equal(statusText(busyDay(), session), '$(ghostline-ghost) 8% · Claude 0,04%');
  assert.equal(statusText(emptyDay('2026-11-11'), { ...session, sessionSpentUsd: 0 }), '$(ghostline-ghost) 0% · Claude 0%');
  assert.equal(
    statusText({ ...emptyDay('2026-11-11'), requests: 11 }, { ...session, sessionSpentUsd: 0.0005 }),
    '$(ghostline-ghost) <1% · Claude <0,01%',
  );
  assert.equal(statusText(busyDay(), { ...session, sessionSpentUsd: 0.375 }), '$(ghostline-ghost) 8% · Claude 0,47%');
  assert.equal(statusText(busyDay(), { ...session, sessionSpentUsd: 2.64 }), '$(ghostline-ghost) 8% · Claude 3,3%');
  assert.equal(statusText(busyDay(), { ...session, sessionSpentUsd: 20 }), '$(ghostline-ghost) 8% · Claude 25%');
  assert.equal(statusText(busyDay(), { ...session, dailyLimit: 0 }), '$(ghostline-ghost) 123 · Claude 0,04%');
  assert.match(statusText(busyDay(), { ...session, paused: true }), /^\$\(ghostline-ghost\) \$\(debug-pause\) 8%/);
  assert.match(statusText(busyDay(), { ...session, triggerMode: 'manual' }), /^\$\(ghostline-ghost\) manual · 8%/);
  assert.match(statusText(busyDay(), { ...session, limitReached: true }), /^\$\(ghostline-ghost\) \$\(circle-slash\) 8%/);
  assert.match(statusText(busyDay(), { ...session, cliError: 'no claude' }), /^\$\(ghostline-ghost\) \$\(warning\) sin CLI$/);
  assert.equal(plainStatus(statusText(busyDay(), session)), 'ghostline 8% · Claude 0,04%');
  assert.equal(plainStatus(statusText(busyDay(), { ...session, paused: true })), 'ghostline 8% · Claude 0,04%');
  assert.equal(plainStatus(statusText(busyDay(), { ...session, triggerMode: 'manual' })), 'ghostline manual · 8% · Claude 0,04%');
  assert.equal(plainStatus(statusText(busyDay(), { ...session, cliError: 'no claude' })), 'ghostline sin CLI');
});

test('tooltip: name and state, the figures with their drawings, warnings, and shortcuts', () => {
  const drawings = (markdown: string): string[] =>
    [...markdown.matchAll(/\]\(data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)\)/g)].map((match) => Buffer.from(match[1] as string, 'base64').toString('utf8'));
  const meters = (markdown: string): number[][] =>
    drawings(markdown)
      .filter((drawing) => drawing.includes(`viewBox="0 0 ${METER_WIDTH} 8"`))
      .map((drawing) => [...drawing.matchAll(/<rect width="(\d+)"/g)].slice(1).map((match) => Number(match[1])));

  const tooltip = tooltipMarkdown(busyDay(), { ...session, rateLimit });
  assert.match(tooltip, /^## !\[ghostline\]\(data:image\/svg\+xml;base64,[^)]+\)&nbsp; ghostline\n\n.*Con Claude Code · modo auto/);
  assert.match(tooltip, /^### !\[\]\([^)]+\)&nbsp; 8% &nbsp;.*· de tu tope diario/m);
  assert.match(tooltip, /123 de 1500 peticiones hoy/);
  assert.match(tooltip, /^### !\[\]\([^)]+\)&nbsp; ≈0,04% &nbsp;.*· de la sesión de Claude \(5 h\)/m);
  assert.match(tooltip, /ghostline: 0,0312 \$ de unos 80 \$ · la sesión entera va por el 59%/);
  assert.match(tooltip, /^### !\[\]\([^)]+\)&nbsp; 34% &nbsp;.*· aceptadas/m);
  assert.match(tooltip, /34 de 100 sugerencias/);
  assert.deepEqual(meters(tooltip), [[25], [185, 8], [102]]);
  assert.deepEqual(meterStops([{ rate: 0.5 }, { rate: 0.7 }]), [150, 300]);
  assert.deepEqual(meterStops([{ rate: 0 }, { rate: 0.0001 }, { rate: -1 }]), [0, 8, 8]);
  for (const drawing of drawings(tooltip)) assert.match(drawing, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" [^>]+>(?:<(?:rect|circle|path|g|\/g)[^<>]*>)+<\/svg>$/);
  assert.match(tooltip, /\[\$\(debug-pause\) Pausar\]\(command:ghostline\.togglePause\)/);
  assert.match(tooltip, /\[\$\(person\) Modo manual\]\(command:ghostline\.toggleTriggerMode\)/);
  for (const [, command] of tooltip.matchAll(/\(command:([\w.]+)/g)) assert.ok(TOOLTIP_COMMANDS.includes(command as string), command);
  const paused = tooltipMarkdown(busyDay(), { ...session, paused: true, triggerMode: 'manual' });
  assert.match(paused, /· en pausa/);
  assert.match(paused, /\[\$\(debug-start\) Reanudar\]/);
  assert.match(paused, /\[\$\(zap\) Modo auto\]/);

  const alone = tooltipMarkdown(busyDay(), session);
  assert.match(alone, /ghostline: 0,0312 \$ de unos 80 \$</);
  assert.deepEqual(meters(alone)[1], [8]);
  assert.deepEqual(meters(tooltipMarkdown(emptyDay('2026-11-11'), { ...session, sessionSpentUsd: 0 })), [[], [], []]);
  const uncapped = tooltipMarkdown(busyDay(), { ...session, dailyLimit: 0 });
  assert.match(uncapped, /^### !\[\]\([^)]+\)&nbsp; 123 &nbsp;.*· peticiones hoy[\s\S]*sin tope diario/m);
  assert.equal(meters(uncapped).length, 2);
  assert.match(tooltipMarkdown(busyDay(), { ...session, sessionSpentUsd: 0.0005 }), /&nbsp; <0,01% &nbsp;/);
  assert.match(tooltipMarkdown(busyDay(), { ...session, muted: ['go al final de línea'] }), /Silenciado 24 h: go al final de línea/);

  const withKey = { ...session, apiKeySource: 'ANTHROPIC_API_KEY' };
  assert.equal(statusText(busyDay(), withKey), '$(ghostline-ghost) 8% · 0,03 $');
  assert.equal(statusText({ ...busyDay(), costUsd: 0.004 }, withKey), '$(ghostline-ghost) 8% · <0,01 $');
  assert.equal(statusText(emptyDay('2026-11-11'), withKey), '$(ghostline-ghost) 0% · 0 $');
  const keyed = tooltipMarkdown(busyDay(), withKey);
  assert.match(keyed, /^### !\[\]\([^)]+\)&nbsp; 0,03 \$ &nbsp;.*· gastado hoy en la API/m);
  assert.match(keyed, /con API key \(ANTHROPIC\\_API\\_KEY\) · 180k tokens/);
  assert.ok(!keyed.includes('sesión de Claude') && !keyed.includes('$(warning)'), keyed);

  assert.match(tooltipMarkdown(busyDay(), { ...session, limitReached: true }), /Límite diario alcanzado \(1500\)/);
  const hostile = tooltipMarkdown(busyDay(), { ...session, cliError: 'no existe C:\\x\\[y](command:evil) <b>$(zap)</b>' });
  assert.ok(!hostile.includes('](command:evil)') && !hostile.includes('<b>'), hostile);
  assert.match(hostile, /\\\[y\\\]\\\(command:evil\\\) &lt;b&gt;\\\$\\\(zap\\\)&lt;\/b&gt;/);
});

test('the Claude session ghostline’s spend is measured against', () => {
  const now = Date.parse('2026-11-12T10:00:00Z');
  const hour = 3600_000;
  const windowEnding = (endMs: number): NonNullable<SessionInfo['rateLimit']> => ({
    status: 'allowed',
    windows: { five_hour: { utilization: 0.2, resetsAt: endMs / 1000, status: 'allowed' } },
  });
  assert.equal(sessionStart(windowEnding(now + 2 * hour), now), now - 3 * hour);
  assert.equal(sessionStart(windowEnding(now - hour), now), now - hour);
  assert.equal(sessionStart(undefined, now), now - 5 * hour);
  assert.equal(sessionStart(windowEnding(now - 9 * hour), now), now - 5 * hour);
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
