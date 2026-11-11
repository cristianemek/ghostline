import { StringDecoder } from 'node:string_decoder';

export type JsonObject = Record<string, unknown>;

/** A single line longer than this is dropped instead of buffered forever. */
const MAX_LINE_CHARS = 4 * 1024 * 1024;

/**
 * Incremental NDJSON parser for the CLI's `--output-format stream-json` output.
 * Tolerates chunks that split a line (or a multi-byte character) anywhere, CRLF line endings,
 * blank lines and lines that are not JSON objects (those are counted and skipped).
 */
export class NdjsonParser {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private overflowing = false;
  badLines = 0;

  constructor(
    private readonly onObject: (obj: JsonObject) => void,
    private readonly onBadLine?: (line: string) => void,
  ) {}

  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (this.overflowing) {
        // Tail of a line whose head was already discarded.
        this.overflowing = false;
      } else {
        this.handleLine(line);
      }
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = '';
      this.overflowing = true;
      this.badLines++;
    }
  }

  /** Flushes a final line that did not end with a newline. */
  end(): void {
    this.buffer += this.decoder.end();
    if (!this.overflowing) this.handleLine(this.buffer);
    this.buffer = '';
    this.overflowing = false;
  }

  private handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.reject(line);
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.reject(line);
      return;
    }
    this.onObject(parsed as JsonObject);
  }

  private reject(line: string): void {
    this.badLines++;
    this.onBadLine?.(line);
  }
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: Readonly<Usage> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** Everything the request sent to the model: fresh input plus both cache counters. */
export function totalInputTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export interface RateLimitWindow {
  utilization: number;
  resetsAt: number;
  status: string;
}

export interface RateLimitInfo {
  status: string;
  windows: Record<string, RateLimitWindow>;
}

export interface InitInfo {
  model: string;
  tools: unknown[];
  mcpServers: unknown[];
  apiKeySource: string;
  cliVersion: string;
}

export interface ResultInfo {
  isError: boolean;
  subtype: string;
  text: string;
  usage: Usage;
  costUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
}

export type CliEvent =
  | ({ kind: 'init' } & InitInfo)
  | { kind: 'messageStart'; usage: Usage }
  | { kind: 'textDelta'; text: string }
  | { kind: 'assistant'; text: string }
  | ({ kind: 'rateLimit' } & RateLimitInfo)
  | ({ kind: 'result' } & ResultInfo)
  | { kind: 'unknown'; type: string };

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function parseUsage(raw: unknown): Usage {
  if (!isObject(raw)) return { ...ZERO_USAGE };
  const details = isObject(raw.output_tokens_details) ? raw.output_tokens_details : {};
  return {
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    thinkingTokens: num(details.thinking_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens),
    cacheWriteTokens: num(raw.cache_creation_input_tokens),
  };
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return list(content)
    .map((block) => (isObject(block) && block.type === 'text' ? str(block.text) : ''))
    .join('');
}

function parseRateLimit(raw: unknown): RateLimitInfo {
  const info = isObject(raw) ? raw : {};
  const windows: Record<string, RateLimitWindow> = {};
  if (isObject(info.unifiedWindows)) {
    for (const [name, value] of Object.entries(info.unifiedWindows)) {
      if (!isObject(value)) continue;
      windows[name] = { utilization: num(value.utilization), resetsAt: num(value.resetsAt), status: str(value.status) };
    }
  }
  const type = str(info.rateLimitType);
  if (type && !(type in windows)) {
    windows[type] = { utilization: num(info.utilization), resetsAt: num(info.resetsAt), status: str(info.status) };
  }
  return { status: str(info.status), windows };
}

/**
 * Maps one raw CLI message to the few events ghostline cares about.
 * Anything else (new message types, hook events, status updates…) becomes `unknown` and is ignored upstream.
 */
export function toCliEvent(obj: JsonObject): CliEvent {
  const type = str(obj.type);
  switch (type) {
    case 'system':
      if (obj.subtype === 'init') {
        return {
          kind: 'init',
          model: str(obj.model),
          tools: list(obj.tools),
          mcpServers: list(obj.mcp_servers),
          apiKeySource: str(obj.apiKeySource),
          cliVersion: str(obj.claude_code_version),
        };
      }
      break;
    case 'stream_event': {
      const event = isObject(obj.event) ? obj.event : {};
      if (event.type === 'message_start' && isObject(event.message)) {
        return { kind: 'messageStart', usage: parseUsage(event.message.usage) };
      }
      if (event.type === 'content_block_delta' && isObject(event.delta) && event.delta.type === 'text_delta') {
        return { kind: 'textDelta', text: str(event.delta.text) };
      }
      break;
    }
    case 'assistant':
      if (isObject(obj.message)) return { kind: 'assistant', text: textOfContent(obj.message.content) };
      break;
    case 'rate_limit_event':
      return { kind: 'rateLimit', ...parseRateLimit(obj.rate_limit_info) };
    case 'result':
      return {
        kind: 'result',
        // The CLI reports API and auth failures as subtype "success" with is_error true: trust is_error only.
        isError: obj.is_error === true,
        subtype: str(obj.subtype),
        text: str(obj.result),
        usage: parseUsage(obj.usage),
        costUsd: num(obj.total_cost_usd),
        durationMs: num(obj.duration_ms),
        durationApiMs: num(obj.duration_api_ms),
        numTurns: num(obj.num_turns),
      };
    default:
      break;
  }
  return { kind: 'unknown', type: type || '<none>' };
}
