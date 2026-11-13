const fs = require('fs');

const mode = process.env.FAKE_MODE || 'ok';
const delayMs = Number(process.env.FAKE_DELAY_MS || 20);
const chunkMs = Number(process.env.FAKE_CHUNK_MS || 0);
const chunks = Math.max(1, Number(process.env.FAKE_CHUNKS || 2));
const inputTokens = Number(process.env.FAKE_INPUT_TOKENS || 1200);
const outputTokens = Number(process.env.FAKE_OUTPUT_TOKENS || 12);
const sessionId = '00000000-0000-4000-8000-000000000001';

if (process.env.FAKE_ARGS_FILE) {
  fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: {
    DISABLE_PROMPT_CACHING: process.env.DISABLE_PROMPT_CACHING || null,
    DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER || null,
  } }));
}

if (mode === 'crash-on-start') {
  process.stderr.write('fake-claude: cannot start\n');
  process.exit(3);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function usage(output) {
  return {
    input_tokens: inputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: output,
    output_tokens_details: { thinking_tokens: 0 },
  };
}

let turn = 0;
let initSent = false;

async function answer(message) {
  turn++;
  if (!initSent) {
    initSent = true;
    emit({
      type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), tools: [], mcp_servers: [],
      model: 'claude-haiku-5-5', apiKeySource: process.env.FAKE_API_KEY_SOURCE || 'none',
      claude_code_version: '2.1.322-fake',
    });
  }
  emit({ type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId });

  if (mode === 'crash') {
    process.stderr.write('fake-claude: boom\n');
    process.exit(1);
  }
  if (mode === 'hang') return;

  if (mode === 'error') {
    emit({
      type: 'assistant',
      message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Invalid API key · Please run /login' }], usage: usage(0) },
      session_id: sessionId,
    });
    emit({
      type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login',
      duration_ms: 5, duration_api_ms: 0, total_cost_usd: 0, num_turns: 1, usage: usage(0), session_id: sessionId,
    });
    return;
  }

  const prompt = typeof message?.message?.content === 'string' ? message.message.content : '';
  const completion = (process.env.FAKE_TEXT || 'fake completion')
    .replace('{turn}', String(turn))
    .replace('{promptLength}', String(prompt.length));
  const line = /<line>([^\n]*)▮([^\n]*)<\/line>\s*$/.exec(prompt);
  const region = /<fix>/.test(prompt) ? /<region>\n([\s\S]*?)\n<\/region>/.exec(prompt) : null;
  const text = region
    ? region[1].replace('expression', 'true').replace('condition', 'a > b')
    : line
      ? `${line[1]}${completion}${line[2]}`
      : completion;

  await sleep(delayMs);
  if (mode === 'noisy') {
    process.stdout.write('this line is not json\n');
    emit({ type: 'active_goal', goal: null });
    emit({ type: 'autocompact_state', state: 'ok' });
    emit({ type: 'some_future_type', payload: { nested: [1, 2, 3] } });
    process.stdout.write('\n');
  }
  emit({
    type: 'stream_event', session_id: sessionId,
    event: { type: 'message_start', message: { model: 'claude-haiku-5-5', role: 'assistant', content: [], usage: usage(1) } },
  });
  emit({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  const size = Math.ceil(text.length / chunks) || 1;
  for (let i = 0; i < text.length; i += size) {
    if (i > 0 && chunkMs > 0) await sleep(chunkMs);
    emit({
      type: 'stream_event', session_id: sessionId,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } },
    });
  }
  emit({
    type: 'assistant', session_id: sessionId,
    message: { model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'text', text }], usage: usage(1) },
  });
  emit({ type: 'stream_event', session_id: sessionId, event: { type: 'content_block_stop', index: 0 } });
  emit({ type: 'stream_event', session_id: sessionId, event: { type: 'message_stop' } });
  emit({
    type: 'rate_limit_event', session_id: sessionId,
    rate_limit_info: {
      status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1, resetsAt: 1800000000,
      unifiedWindows: {
        five_hour: { utilization: 0.1, resetsAt: 1800000000, status: 'allowed' },
        seven_day: { utilization: 0.5, resetsAt: 1800000000, status: 'allowed' },
      },
    },
  });
  emit({
    type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn',
    duration_ms: delayMs + 5, duration_api_ms: delayMs, total_cost_usd: 0.0002, num_turns: 1,
    usage: usage(outputTokens), session_id: sessionId,
  });
}

let buffer = '';
let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf('\n');
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.type === 'user') queue = queue.then(() => answer(message));
  }
});
process.stdin.on('end', () => {
  if (mode === 'hang') process.exit(0);
  queue.then(() => process.exit(0));
});
