import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveCli } from './cli/resolveCli';
import type { InitInfo, RateLimitInfo } from './cli/streamParser';
import { WorkerPool } from './cli/workerPool';
import { ACCEPT_COMMAND, GhostlineProvider } from './completion/provider';
import {
  affectsGhostline,
  affectsPool,
  promptCacheEnabled,
  readConfig,
  setTriggerMode,
  type GhostlineConfig,
} from './config';
import { isPathExcluded } from './context/exclusions';
import { dayRow, statusText, tooltipLines, usesApiKey, type SessionInfo } from './usage/report';
import { TokenEstimator } from './usage/tokenEstimator';
import { UsageTracker, type DayStats } from './usage/usageTracker';

const CALIBRATION_KEY = 'ghostline.calibration.v1';
const CWD_PREFIX = 'ghostline-cwd-';
const STANDBY_MAX_IDLE_MS = 10 * 60_000;
const FLUSH_INTERVAL_MS = 15_000;
const CLI_RETRY_MS = 30_000;

/** What `activate` returns when the extension host runs the end-to-end suite. */
export interface GhostlineTestApi {
  provider: GhostlineProvider;
  today(): DayStats;
  statusText(): string;
  logLines(): string[];
}

class Ghostline implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('ghostline');
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly usage: UsageTracker;
  private readonly estimator: TokenEstimator;
  private readonly provider: GhostlineProvider;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly excludedCache = new Map<string, boolean>();
  private readonly warnedKeySources = new Set<string>();
  private readonly cwd: string;
  private readonly flushTimer: NodeJS.Timeout;
  private config: GhostlineConfig = readConfig();
  private pool: WorkerPool | null = null;
  private paused = false;
  private cliError: string | undefined;
  private cliErrorAt = 0;
  private init: InitInfo | undefined;
  private rateLimit: RateLimitInfo | undefined;
  private renderQueued = false;
  private readonly logLines: string[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.usage = new UsageTracker(context.globalState);
    this.estimator = new TokenEstimator(context.globalState.get(CALIBRATION_KEY));
    this.cwd = fs.mkdtempSync(path.join(os.tmpdir(), CWD_PREFIX));
    this.provider = new GhostlineProvider({
      getConfig: () => this.config,
      getPool: () => this.getPool(),
      isPaused: () => this.paused,
      isExcluded: (document) => this.isExcluded(document),
      usage: this.usage,
      estimator: this.estimator,
      log: (line) => this.log(line),
      onActivity: () => this.queueRender(),
    });

    this.statusBar.command = 'ghostline.showMenu';
    this.statusBar.name = 'ghostline';
    this.statusBar.show();

    this.disposables.push(
      vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, this.provider),
      vscode.commands.registerCommand(ACCEPT_COMMAND, (id: number) => this.provider.accepted(id)),
      vscode.commands.registerCommand('ghostline.showMenu', () => this.showMenu()),
      vscode.commands.registerCommand('ghostline.togglePause', () => this.togglePause()),
      vscode.commands.registerCommand('ghostline.toggleTriggerMode', () => this.toggleTriggerMode()),
      vscode.commands.registerCommand('ghostline.openLog', () => this.channel.show(true)),
      vscode.commands.registerCommand('ghostline.showUsage', () => this.showUsage()),
      vscode.commands.registerCommand('ghostline.resetCounters', () => this.resetCounters()),
      vscode.workspace.onDidChangeConfiguration((event) => this.onConfigChange(event)),
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChange(event)),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const active = event.selections[0]?.active;
        if (active) this.provider.cursorMoved(event.textEditor.document, active);
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.provider.dismiss()),
    );

    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
    setTimeout(() => this.removeStaleCwds(), 5000).unref();
    this.render();
    this.log(`ghostline activo · carpeta de trabajo de la CLI: ${this.cwd}`);
  }

  dispose(): void {
    clearInterval(this.flushTimer);
    this.provider.dispose();
    this.pool?.dispose();
    this.pool = null;
    for (const disposable of this.disposables) disposable.dispose();
    this.statusBar.dispose();
    this.channel.dispose();
    try {
      fs.rmdirSync(this.cwd);
    } catch {
      // A CLI process that is still exiting keeps the folder busy; the next start cleans it up.
    }
  }

  async flush(): Promise<void> {
    await this.usage.flush();
    await this.context.globalState.update(CALIBRATION_KEY, this.estimator.toJSON());
    this.queueRender();
  }

  // --- CLI processes -------------------------------------------------------------------------

  private getPool(): WorkerPool | null {
    if (this.pool) return this.pool;
    if (this.cliError && Date.now() - this.cliErrorAt < CLI_RETRY_MS) return null;
    const testCli = this.testCli();
    const resolved = testCli ? ({ ok: true, command: testCli.command, source: 'test' } as const) : resolveCli(this.config.cliPath);
    if (!resolved.ok) {
      const firstTime = this.cliError !== resolved.message;
      this.cliError = resolved.message;
      this.cliErrorAt = Date.now();
      if (firstTime) {
        this.log(`ERROR: ${resolved.message}`);
        void vscode.window.showErrorMessage(`ghostline: ${resolved.message}`, 'Abrir ajustes').then((choice) => {
          if (choice) void vscode.commands.executeCommand('workbench.action.openSettings', 'ghostline.cliPath');
        });
      }
      this.queueRender();
      return null;
    }
    this.cliError = undefined;
    const { config } = this;
    this.log(
      `CLI: ${resolved.command} (${resolved.source}) · modelo ${config.model} · effort ${config.effort} · ` +
        `procesos ${config.workerMode} · razonamiento ${config.reasoning} · ` +
        `caché de prompts ${promptCacheEnabled(config) ? 'activada' : 'desactivada'}`,
    );
    this.pool = new WorkerPool(
      {
        command: resolved.command,
        commandPrefixArgs: testCli?.prefixArgs,
        model: config.model,
        effort: config.effort,
        systemPromptFile: this.context.asAbsolutePath(
          path.join('resources', config.reasoning === 'adaptive' ? 'system-prompt-adaptive.txt' : 'system-prompt.txt'),
        ),
        cwd: this.cwd,
        mode: config.workerMode,
        recycleEvery: config.recycleEvery,
        requestTimeoutMs: config.requestTimeoutMs,
        standbyMaxIdleMs: STANDBY_MAX_IDLE_MS,
        promptCache: promptCacheEnabled(config),
      },
      {
        onInit: (info) => this.onInit(info),
        onRateLimit: (info) => {
          this.rateLimit = info;
          this.queueRender();
        },
        log: (message) => this.log(message),
      },
    );
    this.queueRender();
    return this.pool;
  }

  /**
   * Test runs only (extension host started with --extensionTestsPath): lets the end-to-end suite
   * point ghostline at the fake CLI. Ignored in normal use.
   */
  private testCli(): { command: string; prefixArgs: string[] } | undefined {
    if (this.context.extensionMode !== vscode.ExtensionMode.Test) return undefined;
    const raw = process.env.GHOSTLINE_TEST_CLI;
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { command?: unknown; prefixArgs?: unknown };
      if (typeof parsed.command !== 'string') return undefined;
      const prefixArgs = Array.isArray(parsed.prefixArgs) ? parsed.prefixArgs.filter((arg) => typeof arg === 'string') : [];
      return { command: parsed.command, prefixArgs };
    } catch {
      return undefined;
    }
  }

  /** Handles for the end-to-end suite. */
  testApi(): GhostlineTestApi {
    return {
      provider: this.provider,
      today: () => this.usage.today(),
      statusText: () => {
        this.render();
        return this.statusBar.text;
      },
      logLines: () => [...this.logLines],
    };
  }

  private log(line: string): void {
    this.channel.appendLine(line);
    if (this.context.extensionMode === vscode.ExtensionMode.Test) this.logLines.push(line);
  }

  private resetPool(): void {
    this.pool?.dispose();
    this.pool = null;
    this.cliError = undefined;
    this.init = undefined;
  }

  private onInit(info: InitInfo): void {
    const first = this.init === undefined;
    this.init = info;
    if (first) {
      this.log(`CLI ${info.cliVersion} · modelo ${info.model} · apiKeySource ${info.apiKeySource || '?'}`);
    }
    if (info.tools.length > 0 || info.mcpServers.length > 0) {
      this.log(
        `AVISO: la CLI arrancó con herramientas o servidores MCP activos ` +
          `(tools: ${info.tools.length}, mcp_servers: ${info.mcpServers.length}); deberían ser listas vacías.`,
      );
    }
    if (usesApiKey(info.apiKeySource) && !this.warnedKeySources.has(info.apiKeySource)) {
      this.warnedKeySources.add(info.apiKeySource);
      this.log(`AVISO: la CLI se autentica con ${info.apiKeySource}, no con la suscripción.`);
      void vscode.window
        .showWarningMessage(
          `ghostline: la CLI de Claude Code está usando una API key (${info.apiKeySource}). ` +
            'Cada sugerencia se factura en la API en lugar de ir contra tu suscripción.',
          'Pausar ghostline',
          'Entendido',
        )
        .then((choice) => {
          if (choice === 'Pausar ghostline' && !this.paused) this.togglePause();
        });
    }
    this.queueRender();
  }

  // --- Events --------------------------------------------------------------------------------

  private onConfigChange(event: vscode.ConfigurationChangeEvent): void {
    if (!affectsGhostline(event)) return;
    this.config = readConfig();
    this.excludedCache.clear();
    if (affectsPool(event)) {
      this.resetPool();
      this.provider.clearCache();
    }
    this.queueRender();
  }

  private onDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    if (event.contentChanges.length === 0 || event.reason !== undefined) return;
    if (event.document !== vscode.window.activeTextEditor?.document) return;
    this.provider.noteKeystroke();
    // Typing is the best predictor of a request: make sure a process is warming up.
    if (!this.config.enabled || this.paused) return;
    const { scheme } = event.document.uri;
    if (scheme !== 'file' && scheme !== 'untitled') return;
    if (this.isExcluded(event.document)) return;
    this.getPool()?.warm();
  }

  /** Sensitive files: checked with VS Code's own matcher and with ours; either one excludes. */
  private isExcluded(document: vscode.TextDocument): boolean {
    const key = document.uri.toString();
    const known = this.excludedCache.get(key);
    if (known !== undefined) return known;
    const patterns = this.config.excludePatterns;
    let excluded = isPathExcluded(document.uri.fsPath || document.uri.path, patterns);
    if (!excluded) {
      excluded = patterns.some((pattern) => {
        try {
          return vscode.languages.match({ pattern }, document) > 0;
        } catch {
          return false;
        }
      });
    }
    if (this.excludedCache.size > 500) this.excludedCache.clear();
    this.excludedCache.set(key, excluded);
    return excluded;
  }

  // --- Commands ------------------------------------------------------------------------------

  private togglePause(): void {
    this.paused = !this.paused;
    if (this.paused) this.provider.dismiss();
    this.render();
  }

  private async toggleTriggerMode(): Promise<void> {
    await setTriggerMode(this.config.triggerMode === 'auto' ? 'manual' : 'auto');
  }

  private async resetCounters(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      'ghostline: ¿borrar los contadores de consumo de los últimos 30 días?',
      { modal: true },
      'Borrar',
    );
    if (choice !== 'Borrar') return;
    await this.usage.reset();
    this.render();
  }

  private async showMenu(): Promise<void> {
    type Action = vscode.QuickPickItem & { run: () => unknown };
    const manual = this.config.triggerMode === 'manual';
    const actions: Action[] = [
      {
        label: this.paused ? '$(debug-start) Reanudar' : '$(debug-pause) Pausar',
        description: this.paused ? 'ghostline está en pausa' : undefined,
        run: () => this.togglePause(),
      },
      {
        label: manual ? '$(zap) Cambiar a modo auto' : '$(person) Cambiar a modo manual',
        description: manual ? 'ahora: solo al invocar la sugerencia' : 'ahora: sugiere al dejar de teclear',
        run: () => this.toggleTriggerMode(),
      },
      { label: '$(output) Abrir el log', run: () => this.channel.show(true) },
      { label: '$(graph) Consumo de los últimos 7 días', run: () => this.showUsage() },
      { label: '$(trash) Reiniciar contadores', run: () => this.resetCounters() },
      {
        label: '$(gear) Ajustes de ghostline',
        run: () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:cristianemek.ghostline'),
      },
    ];
    const picked = await vscode.window.showQuickPick(actions, { title: 'ghostline', placeHolder: this.statusBar.text });
    await picked?.run();
  }

  private async showUsage(): Promise<void> {
    await this.usage.flush();
    const formatter = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
    const items: vscode.QuickPickItem[] = this.usage.lastDays(7).map((day, index) => {
      const row = dayRow(day, this.usage.latency(day), this.usage.medianInputTokens(day));
      const [year, month, date] = day.date.split('-').map(Number);
      const label = formatter.format(new Date(year ?? 0, (month ?? 1) - 1, date ?? 1));
      return { label: index === 0 ? `${label} (hoy)` : label, description: row.summary, detail: row.detail };
    });
    await vscode.window.showQuickPick(items, {
      title: 'ghostline: consumo de los últimos 7 días',
      placeHolder: 'peticiones · tokens totales · sugerencias aceptadas',
    });
  }

  // --- Status bar ----------------------------------------------------------------------------

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setTimeout(() => {
      this.renderQueued = false;
      this.render();
    }, 150);
  }

  private render(): void {
    const { config } = this;
    if (!config.enabled) {
      this.statusBar.text = '$(circle-slash) ghostline';
      this.statusBar.tooltip = 'ghostline está desactivado ("ghostline.enabled": false).';
      this.statusBar.backgroundColor = undefined;
      return;
    }
    const day = this.usage.today();
    const session: SessionInfo = {
      triggerMode: config.triggerMode,
      workerMode: config.workerMode,
      paused: this.paused,
      limitReached: this.usage.overDailyLimit(config.dailyRequestLimit),
      dailyLimit: config.dailyRequestLimit,
      model: this.init?.model || config.model,
      apiKeySource: this.init?.apiKeySource,
      cliError: this.cliError,
      rateLimit: this.rateLimit,
    };
    this.statusBar.text = statusText(day, session);
    const tooltip = new vscode.MarkdownString(
      tooltipLines(day, this.usage.latency(day), this.usage.medianInputTokens(day), session).join('  \n'),
      true,
    );
    this.statusBar.tooltip = tooltip;
    this.statusBar.backgroundColor = session.cliError
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : usesApiKey(session.apiKeySource) || session.limitReached
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
  }

  /** Removes working folders left behind by earlier sessions (only if empty: rmdir, never recursive). */
  private removeStaleCwds(): void {
    const tmp = os.tmpdir();
    let names: string[];
    try {
      names = fs.readdirSync(tmp);
    } catch {
      return;
    }
    const dayAgo = Date.now() - 24 * 3600_000;
    for (const name of names) {
      if (!name.startsWith(CWD_PREFIX)) continue;
      const dir = path.join(tmp, name);
      if (dir === this.cwd) continue;
      try {
        if (fs.statSync(dir).mtimeMs < dayAgo) fs.rmdirSync(dir);
      } catch {
        // In use by another window, or not empty: leave it.
      }
    }
  }
}

let instance: Ghostline | undefined;

export function activate(context: vscode.ExtensionContext): GhostlineTestApi | undefined {
  instance = new Ghostline(context);
  context.subscriptions.push(instance);
  return context.extensionMode === vscode.ExtensionMode.Test ? instance.testApi() : undefined;
}

export async function deactivate(): Promise<void> {
  await instance?.flush();
  instance = undefined;
}
