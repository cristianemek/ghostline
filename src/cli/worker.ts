import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { userMessageLine } from './args';
import { ensureEmptyWorkFolder } from './workFolder';
import {
  NdjsonParser,
  ZERO_USAGE,
  toCliEvent,
  type InitInfo,
  type JsonObject,
  type RateLimitInfo,
  type Usage,
} from './streamParser';

export interface WorkerSpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface WorkerEvents {
  onInit?(info: InitInfo): void;
  onRateLimit?(info: RateLimitInfo): void;
  /** The process is gone, whatever the reason (retired, killed, crashed, failed to start). */
  onExit?(worker: CliWorker, detail: string): void;
}

export interface TurnOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called after every text delta; returning true kills the process and keeps the text so far. */
  shouldStop?(textSoFar: string): boolean;
}

export type TurnStatus = 'ok' | 'error' | 'timeout' | 'cancelled';

export interface TurnResult {
  status: TurnStatus;
  text: string;
  errorMessage?: string;
  usage: Usage;
  /** True when the turn was cut short: usage comes from `message_start` plus an output estimate. */
  usagePartial: boolean;
  costUsd: number;
  firstTokenMs: number | null;
  totalMs: number;
  apiMs: number | null;
  /** API round trips the CLI made for this message; more than one means it retried on its own. */
  numTurns: number;
  stoppedEarly: boolean;
}

interface TurnState {
  startedAt: number;
  text: string;
  assistantText: string;
  firstTokenAt: number | null;
  startUsage: Usage | null;
  options: TurnOptions;
  timer: NodeJS.Timeout;
  onAbort: () => void;
  resolve: (result: TurnResult) => void;
}

const STDERR_TAIL_CHARS = 2000;

/**
 * What the CLI prints on failure ends up in ghostline's log, which people paste into bug reports.
 * Anything in it that looks like a key or a session token is blanked out first.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '***')
    .replace(/((?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|authorization|x-api-key|password|secret)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, '$1***')
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1***@');
}
/** Rough output-token estimate for turns that never reached `result`. */
const OUTPUT_CHARS_PER_TOKEN = 3;

/**
 * One `claude -p` process speaking stream-json on stdin/stdout.
 * The CLI prints nothing until it receives input, so a worker has no observable "ready" state:
 * it can be written to right after spawning and simply answers sooner the older it is.
 */
export class CliWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly parser: NdjsonParser;
  private readonly spawnedAt = performance.now();
  private turn: TurnState | null = null;
  private exited = false;
  /** Set as soon as we ask the process to go away; the exit itself arrives later. */
  private stopping = false;
  private stderrTail = '';
  private retireTimer: NodeJS.Timeout | null = null;
  turnsServed = 0;

  constructor(
    options: WorkerSpawnOptions,
    private readonly events: WorkerEvents = {},
  ) {
    this.parser = new NdjsonParser((obj) => this.handleMessage(obj));
    // Throws, and nothing is launched, unless the working folder is empty (see workFolder.ts).
    ensureEmptyWorkFolder(options.cwd);
    // shell: false always. Arguments reach the CLI verbatim, including the empty string of `--tools ""`.
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.parser.push(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });
    // Writing to a process that already died raises EPIPE on the stream; the close handler reports it.
    this.child.stdin.on('error', () => undefined);
    this.child.on('error', (error) => this.handleExit(`no se pudo lanzar la CLI: ${error.message}`));
    this.child.on('close', (code, signal) => {
      this.parser.end();
      const stderr = redactSecrets(this.stderrTail.trim());
      const how = signal ? `señal ${signal}` : `código ${code ?? '?'}`;
      this.handleExit(`la CLI terminó (${how})${stderr ? `: ${stderr}` : ''}`);
    });
  }

  /** True while the process can still take a message (not exited, killed or retired). */
  get alive(): boolean {
    return !this.exited && !this.stopping;
  }

  get busy(): boolean {
    return this.turn !== null;
  }

  get ageMs(): number {
    return performance.now() - this.spawnedAt;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Sends one user message and resolves when the CLI reports its result (or the turn is cut short). */
  runTurn(prompt: string, options: TurnOptions): Promise<TurnResult> {
    if (this.turn) throw new Error('CliWorker: ya hay una petición en curso en este proceso');
    const startedAt = performance.now();
    if (!this.alive) {
      return Promise.resolve(this.failure('error', startedAt, 'el proceso de la CLI ya no está en ejecución'));
    }
    if (options.signal?.aborted) {
      // Nothing was sent, so the process is still as good as new: leave it alone.
      return Promise.resolve(this.failure('cancelled', startedAt));
    }
    return new Promise<TurnResult>((resolve) => {
      const onAbort = (): void => {
        this.finish({ status: 'cancelled' });
        this.kill();
      };
      const timer = setTimeout(() => {
        this.finish({ status: 'timeout', errorMessage: `sin respuesta en ${options.timeoutMs} ms` });
        this.kill();
      }, options.timeoutMs);
      this.turn = {
        startedAt,
        text: '',
        assistantText: '',
        firstTokenAt: null,
        startUsage: null,
        options,
        timer,
        onAbort,
        resolve,
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.child.stdin.write(userMessageLine(prompt));
    });
  }

  /** Lets the process exit on its own by closing stdin; force-kills it if it lingers. */
  retire(graceMs = 2000): void {
    if (this.exited || this.stopping) return;
    this.stopping = true;
    this.child.stdin.end();
    this.retireTimer = setTimeout(() => this.kill(), graceMs);
    this.retireTimer.unref();
  }

  kill(): void {
    if (this.exited) return;
    this.stopping = true;
    this.child.kill();
  }

  private handleMessage(obj: JsonObject): void {
    const event = toCliEvent(obj);
    switch (event.kind) {
      case 'init':
        this.events.onInit?.(event);
        return;
      case 'rateLimit':
        this.events.onRateLimit?.(event);
        return;
      default:
        break;
    }
    const turn = this.turn;
    if (!turn) return;
    switch (event.kind) {
      case 'messageStart':
        turn.startUsage = event.usage;
        break;
      case 'textDelta':
        if (turn.firstTokenAt === null) turn.firstTokenAt = performance.now();
        turn.text += event.text;
        if (turn.options.shouldStop?.(turn.text)) {
          this.finish({ status: 'ok', stoppedEarly: true });
          this.kill();
        }
        break;
      case 'assistant':
        turn.assistantText += event.text;
        break;
      case 'result':
        this.turnsServed++;
        this.finish({
          status: event.isError ? 'error' : 'ok',
          // `result` is the authoritative final text; the deltas only matter when it is missing.
          text: event.isError ? '' : event.text || turn.text || turn.assistantText,
          errorMessage: event.isError ? event.text || `la CLI devolvió un error (${event.subtype})` : undefined,
          usage: event.usage,
          costUsd: event.costUsd,
          apiMs: event.durationApiMs,
          numTurns: event.numTurns,
        });
        break;
      default:
        break;
    }
  }

  private handleExit(detail: string): void {
    if (this.exited) return;
    this.exited = true;
    if (this.retireTimer) clearTimeout(this.retireTimer);
    if (this.turn) this.finish({ status: 'error', errorMessage: detail });
    this.events.onExit?.(this, detail);
  }

  private finish(outcome: {
    status: TurnStatus;
    text?: string;
    errorMessage?: string;
    usage?: Usage;
    costUsd?: number;
    apiMs?: number;
    numTurns?: number;
    stoppedEarly?: boolean;
  }): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    clearTimeout(turn.timer);
    turn.options.signal?.removeEventListener('abort', turn.onAbort);
    const now = performance.now();
    const text = outcome.text ?? turn.text;
    // Cut short after the model started answering: the input was already consumed, so report it.
    const partial = outcome.usage === undefined && turn.startUsage !== null;
    const usage: Usage =
      outcome.usage ??
      (turn.startUsage
        ? { ...turn.startUsage, outputTokens: Math.ceil(turn.text.length / OUTPUT_CHARS_PER_TOKEN) }
        : { ...ZERO_USAGE });
    turn.resolve({
      status: outcome.status,
      text: outcome.status === 'ok' ? text : '',
      errorMessage: outcome.errorMessage,
      usage,
      usagePartial: partial,
      costUsd: outcome.costUsd ?? 0,
      firstTokenMs: turn.firstTokenAt === null ? null : turn.firstTokenAt - turn.startedAt,
      totalMs: now - turn.startedAt,
      apiMs: outcome.apiMs ?? null,
      numTurns: outcome.numTurns ?? 0,
      stoppedEarly: outcome.stoppedEarly ?? false,
    });
  }

  private failure(status: TurnStatus, startedAt: number, errorMessage?: string): TurnResult {
    return {
      status,
      text: '',
      errorMessage,
      usage: { ...ZERO_USAGE },
      usagePartial: false,
      costUsd: 0,
      firstTokenMs: null,
      totalMs: performance.now() - startedAt,
      apiMs: null,
      numTurns: 0,
      stoppedEarly: false,
    };
  }
}
