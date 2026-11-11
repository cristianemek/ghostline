import { mkdirSync } from 'node:fs';
import { buildCliArgs, buildCliEnv } from './args';
import type { InitInfo, RateLimitInfo } from './streamParser';
import { CliWorker, type TurnResult } from './worker';

export type WorkerMode = 'single-use' | 'persistent';

export interface PoolConfig {
  /** Resolved executable, launched without a shell. */
  command: string;
  /** Arguments placed before the CLI flags (the tests use it to run `node fake-claude.js`). */
  commandPrefixArgs?: string[];
  model: string;
  effort: string;
  systemPromptFile: string;
  /** An empty folder of our own. Never the project folder. */
  cwd: string;
  mode: WorkerMode;
  /** Persistent mode: requests served by one process before its conversation is thrown away. */
  recycleEvery: number;
  requestTimeoutMs: number;
  /** A standby process that has waited this long is retired. */
  standbyMaxIdleMs: number;
  promptCache: boolean;
  env?: NodeJS.ProcessEnv;
  /** Appended after the standard flags (used by the benchmark to compare CLI configurations). */
  extraArgs?: string[];
}

export interface PoolEvents {
  onInit?(info: InitInfo): void;
  onRateLimit?(info: RateLimitInfo): void;
  log?(message: string): void;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  shouldStop?(textSoFar: string): boolean;
}

export interface CompletionOutcome extends TurnResult {
  /** Time spent getting hold of a process before the prompt could be written. */
  waitForWorkerMs: number;
  /** How long the process had been running when it received the prompt (small = cold start). */
  workerAgeMs: number;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Keeps exactly one pre-launched CLI process waiting so a completion never pays the process start-up.
 *
 * single-use (default): every request takes the standby process, uses it for one message and throws it
 * away, so each suggestion is a brand-new conversation with a constant, small cost.
 * persistent: one process serves up to `recycleEvery` requests before being replaced by the standby.
 */
export class WorkerPool {
  private standby: CliWorker | null = null;
  private standbyTimer: NodeJS.Timeout | null = null;
  /** Persistent mode only: the long-lived process, idle between requests. */
  private active: CliWorker | null = null;
  private activeTimer: NodeJS.Timeout | null = null;
  private inFlight: AbortController | null = null;
  private disposed = false;
  private standbyFailures = 0;
  private nextSpawnAllowedAt = 0;
  spawnCount = 0;

  constructor(
    private readonly config: PoolConfig,
    private readonly events: PoolEvents = {},
  ) {}

  /** Makes sure a standby process exists. Cheap to call often (on typing, on focus…). */
  warm(): void {
    if (this.disposed || this.standby?.alive) return;
    if (Date.now() < this.nextSpawnAllowedAt) return;
    this.standby = this.spawnWorker();
    this.armStandbyTimer();
  }

  /** At most one request is in flight: a new one cancels the previous one. */
  async request(prompt: string, options: RequestOptions = {}): Promise<CompletionOutcome> {
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const forward = (): void => controller.abort();
    options.signal?.addEventListener('abort', forward, { once: true });
    if (options.signal?.aborted) controller.abort();

    const acquireStart = performance.now();
    try {
      if (this.disposed || controller.signal.aborted) return cancelledOutcome();
      const worker = this.acquire();
      if (!worker) {
        return { ...cancelledOutcome(), status: 'error', errorMessage: 'no se pudo lanzar la CLI' };
      }
      const waitForWorkerMs = performance.now() - acquireStart;
      const workerAgeMs = worker.ageMs;
      const result = await worker.runTurn(prompt, {
        timeoutMs: options.timeoutMs ?? this.config.requestTimeoutMs,
        signal: controller.signal,
        shouldStop: options.shouldStop,
      });
      this.release(worker, result);
      return { ...result, waitForWorkerMs, workerAgeMs };
    } finally {
      options.signal?.removeEventListener('abort', forward);
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.inFlight?.abort();
    this.clearStandbyTimer();
    this.clearActiveTimer();
    this.standby?.kill();
    this.active?.kill();
    this.standby = null;
    this.active = null;
  }

  private acquire(): CliWorker | null {
    if (this.config.mode === 'persistent') {
      const active = this.active;
      this.clearActiveTimer();
      if (active?.alive && !active.busy && active.turnsServed < this.config.recycleEvery) return active;
      // Either a recycle is due or the process died: drop it and promote the standby.
      active?.retire();
      this.active = this.takeStandby();
      this.replenish();
      return this.active;
    }
    const worker = this.takeStandby();
    // Launch the next standby right away so it warms up while this request is being served.
    this.replenish();
    return worker;
  }

  private release(worker: CliWorker, result: TurnResult): void {
    if (result.status === 'ok') this.standbyFailures = 0;
    if (this.config.mode === 'persistent' && worker === this.active) {
      const reusable = worker.alive && result.status === 'ok' && !result.stoppedEarly;
      if (reusable && worker.turnsServed < this.config.recycleEvery) {
        this.armActiveTimer();
        return;
      }
      this.clearActiveTimer();
      this.active = null;
      if (reusable) worker.retire();
      else worker.kill();
      return;
    }
    // Single use: a clean result lets the CLI exit on its own; anything else is killed on the spot
    // so it stops generating output.
    if (result.status === 'ok' && !result.stoppedEarly) worker.retire();
    else worker.kill();
  }

  private takeStandby(): CliWorker | null {
    const standby = this.standby;
    this.standby = null;
    this.clearStandbyTimer();
    if (standby?.alive) return standby;
    return this.spawnWorker();
  }

  private replenish(): void {
    if (this.disposed || this.standby?.alive) return;
    this.standby = this.spawnWorker();
    this.armStandbyTimer();
  }

  private spawnWorker(): CliWorker | null {
    const { config } = this;
    const args = [
      ...(config.commandPrefixArgs ?? []),
      ...buildCliArgs({ model: config.model, effort: config.effort, systemPromptFile: config.systemPromptFile }),
      ...(config.extraArgs ?? []),
    ];
    try {
      // The working folder lives in the OS temp directory, where anything may clean it up while the
      // editor is open. Without it every launch fails with a misleading "ENOENT".
      mkdirSync(config.cwd, { recursive: true });
      this.spawnCount++;
      return new CliWorker(
        {
          command: config.command,
          args,
          cwd: config.cwd,
          env: buildCliEnv(config.env ?? process.env, { promptCache: config.promptCache }),
        },
        {
          onInit: (info) => this.events.onInit?.(info),
          onRateLimit: (info) => this.events.onRateLimit?.(info),
          onExit: (worker, detail) => this.handleExit(worker, detail),
        },
      );
    } catch (error) {
      this.events.log?.(`no se pudo lanzar la CLI: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private handleExit(worker: CliWorker, detail: string): void {
    if (worker === this.active) this.active = null;
    if (worker !== this.standby) return;
    // A standby process should only ever exit because we retired it. Back off so a broken
    // installation does not turn into a respawn loop; the next request still spawns on demand.
    this.standby = null;
    this.clearStandbyTimer();
    if (this.disposed) return;
    this.standbyFailures++;
    const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.standbyFailures);
    this.nextSpawnAllowedAt = Date.now() + backoff;
    this.events.log?.(`el proceso en espera terminó solo (${detail}); reintento en ${Math.round(backoff / 1000)} s`);
  }

  private armStandbyTimer(): void {
    this.clearStandbyTimer();
    this.standbyTimer = setTimeout(() => {
      // Idle for too long: retire it instead of keeping a stale process (and its memory) around.
      // warm() or the next request launches a fresh one.
      const stale = this.standby;
      this.standby = null;
      this.standbyTimer = null;
      stale?.retire();
    }, this.config.standbyMaxIdleMs);
    this.standbyTimer.unref();
  }

  private clearStandbyTimer(): void {
    if (this.standbyTimer) clearTimeout(this.standbyTimer);
    this.standbyTimer = null;
  }

  /** Persistent mode: an idle long-lived process is retired after the same idle time as a standby. */
  private armActiveTimer(): void {
    this.clearActiveTimer();
    this.activeTimer = setTimeout(() => {
      const idle = this.active;
      this.active = null;
      this.activeTimer = null;
      idle?.retire();
    }, this.config.standbyMaxIdleMs);
    this.activeTimer.unref();
  }

  private clearActiveTimer(): void {
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.activeTimer = null;
  }
}

function cancelledOutcome(): CompletionOutcome {
  return {
    status: 'cancelled',
    text: '',
    usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    usagePartial: false,
    costUsd: 0,
    firstTokenMs: null,
    totalMs: 0,
    apiMs: null,
    numTurns: 0,
    stoppedEarly: false,
    waitForWorkerMs: 0,
    workerAgeMs: 0,
  };
}
