import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { endpointOverride } from './cli/args';
import { resolveCli } from './cli/resolveCli';
import type { InitInfo, RateLimitInfo } from './cli/streamParser';
import { WORK_FOLDER_PREFIX, createWorkFolder, ensureEmptyWorkFolder, removeStaleWorkFolders } from './cli/workFolder';
import { WorkerPool } from './cli/workerPool';
import { NoteHint } from './completion/noteHint';
import { CommitGenerator } from './scm/commitGenerator';
import type { ChangedFile } from './scm/commitMessage';
import { ACCEPT_COMMAND, GhostlineProvider } from './completion/provider';
import { typedInsertionEnd } from './completion/trigger';
import {
  affectsGhostline,
  affectsPool,
  promptCacheEnabled,
  readConfig,
  setTriggerMode,
  updateSetting,
  type GhostlineConfig,
} from './config';
import { isPathExcluded, unusablePatterns } from './context/exclusions';
import { isIndexable, projectBlock } from './context/projectIndex';
import { ProjectIndexer } from './context/projectIndexer';
import { EditSuggester, type Proposal } from './edit/editSuggester';
import { createSymbolProvider } from './context/symbols';
import { AdaptiveTrigger, type ContextReport } from './learning/adaptiveTrigger';
import { ExampleStore } from './learning/exampleStore';
import { CONTEXT_LABELS, Learning } from './learning/learning';
import { StyleManager, type Launcher } from './learning/styleManager';
import { RecentSuggestions, formatRecent, type RecentEntry } from './usage/recent';
import {
  MARK,
  SLOW_P50_MS,
  TOOLTIP_COMMANDS,
  dayRow,
  plainStatus,
  sessionStart,
  statusText,
  tooltipMarkdown,
  usesApiKey,
  type SessionInfo,
} from './usage/report';
import { TokenEstimator } from './usage/tokenEstimator';
import { UsageTracker, type DayStats } from './usage/usageTracker';

const CALIBRATION_KEY = 'ghostline.calibration.v1';
const WORK_FOLDERS = 'cli';
const LEGACY_CWD_PREFIX = 'ghostline-cwd-';
const STANDBY_MAX_IDLE_MS = 10 * 60_000;
const FLUSH_INTERVAL_MS = 15_000;
const CLI_RETRY_MS = 30_000;
const SPEED_WARNING_KEY = 'ghostline.speedWarning.v1';
const API_KEY_NOTICE_KEY = 'ghostline.apiKeyNotice.v1';
const ENDPOINT_ACK_KEY = 'ghostline.endpointAck.v1';
const MIN_REQUESTS_FOR_SPEED_WARNING = 20;

export interface GhostlineTestApi {
  provider: GhostlineProvider;
  today(): DayStats;
  statusText(): string;
  logLines(): string[];
  exampleCount(): number;
  confirmExamples(): void;
  recent(): RecentEntry[];
  systemPrompt(): Promise<string>;
  checkEdits(): Promise<void>;
  pendingEdit(): Proposal | undefined;
  shownNote(): string | undefined;
  commitMessageFor(files: ChangedFile[], recent: string[]): Promise<string>;
  adaptiveReport(): ContextReport[];
  refreshCount(): number;
  config(): GhostlineConfig;
  styleProfile(): string | undefined;
  learnStyleFrom(paths: string[]): Promise<string>;
}

class Ghostline implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('ghostline');
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly usage: UsageTracker;
  private readonly estimator: TokenEstimator;
  private readonly provider: GhostlineProvider;
  private readonly examples: ExampleStore;
  private readonly adaptive: AdaptiveTrigger;
  private readonly style: StyleManager;
  private readonly recent: RecentSuggestions;
  private readonly learning: Learning;
  private readonly indexer: ProjectIndexer;
  private readonly edits: EditSuggester;
  private readonly notes: NoteHint;
  private readonly commits: CommitGenerator;
  private systemPromptFile = '';
  private systemPromptSource = '';
  private projectChars = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly excludedCache = new Map<string, boolean>();
  private readonly warnedKeySources = new Set<string>();
  private readonly shownTroubles = new Set<string>();
  private refreshes = 0;
  private cwd: string;
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
    this.cwd = createWorkFolder(path.join(context.globalStorageUri.fsPath, WORK_FOLDERS));
    this.examples = new ExampleStore(context.workspaceState);
    this.recent = new RecentSuggestions(context.workspaceState);
    this.indexer = new ProjectIndexer({ isPathExcluded: (file) => isPathExcluded(file, this.config.excludePatterns) });
    this.adaptive = new AdaptiveTrigger(context.globalState);
    this.style = new StyleManager({
      context,
      getConfig: () => this.config,
      launcher: () => this.launcher(),
      cwd: () => this.cwd,
      charsPerToken: () => this.estimator.charsPerToken,
      usage: this.usage,
      log: (line) => this.log(line),
      onChange: () => this.queueRender(),
    });
    this.learning = new Learning({
      examples: this.examples,
      adaptive: this.adaptive,
      styleProfile: () => this.style.profile,
      settings: () => this.config,
      charsPerToken: () => this.estimator.charsPerToken,
      readDocument: (documentKey) => vscode.workspace.textDocuments.find((document) => document.uri.toString() === documentKey)?.getText(),
      onMuted: (languageId, triggerContext) => {
        const where = `${languageId} ${CONTEXT_LABELS[triggerContext]}`;
        this.log(`disparo adaptativo: casi nunca aceptas sugerencias en ${where}; silenciado 24 h (el modo manual sigue)`);
        void vscode.window.showInformationMessage(
          `ghostline: en ${where} casi nunca aceptas las sugerencias, así que dejo de sugerir ahí durante 24 h. ` +
            'La invocación manual sigue funcionando.',
        );
      },
    });
    this.notes = new NoteHint(context.extensionUri);
    this.provider = new GhostlineProvider({
      getConfig: () => this.config,
      getPool: () => this.getPool(),
      isPaused: () => this.paused,
      isExcluded: (document) => this.isExcluded(document),
      usage: this.usage,
      estimator: this.estimator,
      log: (line) => this.log(line),
      onActivity: () => this.queueRender(),
      onTrouble: (message, pauseMs) => this.onTrouble(message, pauseMs),
      refresh: (documentKey) => {
        this.refreshes++;
        if (vscode.window.activeTextEditor?.document.uri.toString() !== documentKey) return;
        void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      },
      learning: this.learning,
      journal: this.recent,
      projectContextChars: () => this.projectChars,
      onNote: (document, position, note) => this.notes.show(document, position, note),
      onChange: (document, position, change, id) => this.edits.propose(document, position.line, change, id),
      symbols: createSymbolProvider({
        isPathExcluded: (file) => isPathExcluded(file, this.config.excludePatterns),
        charsPerToken: () => this.estimator.charsPerToken,
        window: () => ({ prefixLines: this.config.prefixLines, suffixLines: this.config.suffixLines }),
      }),
    });
    void this.style.load();
    this.edits = new EditSuggester({
      getConfig: () => this.config,
      getPool: () => this.getPool(),
      isPaused: () => this.paused,
      isExcluded: (document) => this.isExcluded(document),
      completionBusy: () => this.provider.busy,
      lastTyped: (document) => {
        const typed = this.provider.lastTyped;
        if (!typed || typed.documentKey !== document.uri.toString()) return undefined;
        return { line: document.positionAt(typed.offset).line, at: typed.at };
      },
      usage: this.usage,
      estimator: this.estimator,
      log: (line) => this.log(line),
      onActivity: () => this.queueRender(),
      onShown: () => this.notes.clear(),
      journal: this.recent,
    });
    this.commits = new CommitGenerator({
      context,
      getConfig: () => this.config,
      launcher: () => this.launcher(),
      cwd: () => this.cwd,
      usage: this.usage,
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
      vscode.commands.registerCommand('ghostline.learnProjectStyle', () => this.style.learn()),
      vscode.commands.registerCommand('ghostline.editProjectStyle', () => this.style.edit()),
      vscode.commands.registerCommand('ghostline.clearLearning', () => this.clearLearning()),
      vscode.commands.registerCommand('ghostline.showRecent', () => this.showRecent()),
      vscode.commands.registerCommand('ghostline.openSettings', () => this.openSettings()),
      vscode.commands.registerCommand('ghostline.generateCommitMessage', (source?: { rootUri?: vscode.Uri }) => this.commits.run(source)),
      vscode.commands.registerCommand('ghostline.acceptEdit', () => this.edits.accept()),
      vscode.commands.registerCommand('ghostline.dismissEdit', () => this.edits.dismiss()),
      vscode.languages.onDidChangeDiagnostics((event) => this.edits.diagnosticsChanged(event.uris)),
      vscode.window.onDidChangeActiveTextEditor(() => this.edits.editorChanged()),
      vscode.workspace.onDidSaveTextDocument((document) => this.style.onSaved(document)),
      vscode.workspace.onDidSaveTextDocument((document) => this.indexFile(document.uri)),
      vscode.workspace.onDidCreateFiles((event) => event.files.forEach((uri) => this.indexFile(uri))),
      vscode.workspace.onDidDeleteFiles((event) => {
        if (event.files.map((uri) => this.indexer.remove(uri)).some(Boolean)) this.refreshProjectContext();
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        for (const { oldUri, newUri } of event.files) {
          this.indexer.remove(oldUri);
          this.indexFile(newUri);
        }
        this.refreshProjectContext();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshProjectContext()),
      vscode.workspace.onDidChangeConfiguration((event) => this.onConfigChange(event)),
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChange(event)),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const active = event.selections[0]?.active;
        if (active) this.provider.cursorMoved(event.textEditor.document, active);
        this.edits.selectionChanged(event.textEditor);
        this.notes.selectionChanged(event.textEditor);
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.provider.dismiss()),
      vscode.window.onDidChangeActiveTextEditor(() => this.notes.clear()),
      this.notes,
    );

    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
    setTimeout(() => this.removeStaleCwds(), 5000).unref();
    this.refreshProjectContext();
    setTimeout(() => this.scanProject(), 1500).unref();
    this.render();
    this.log(`ghostline activo · carpeta de trabajo de la CLI: ${this.cwd}`);
  }

  dispose(): void {
    clearInterval(this.flushTimer);
    this.edits.dispose();
    this.provider.dispose();
    this.pool?.dispose();
    this.pool = null;
    for (const disposable of this.disposables) disposable.dispose();
    this.statusBar.dispose();
    this.channel.dispose();
    try {
      fs.rmdirSync(this.cwd);
    } catch {}
  }

  async flush(): Promise<void> {
    await this.usage.flush();
    await this.context.globalState.update(CALIBRATION_KEY, this.estimator.toJSON());
    this.maybeWarnSlow();
    this.queueRender();
  }

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
    for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
      if (process.env[name]) this.noteApiKey(name);
    }
    this.warnAboutEndpoint();
    try {
      ensureEmptyWorkFolder(this.cwd);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.cwd = createWorkFolder(path.join(this.context.globalStorageUri.fsPath, WORK_FOLDERS));
      this.log(`AVISO: ${detail}. Se usa una carpeta nueva: ${this.cwd}`);
      void vscode.window.showWarningMessage(
        `ghostline: ${detail}. Se usa una carpeta nueva; si no sabes qué ha escrito ahí, revísalo.`,
      );
    }
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
        systemPromptFile: this.systemPromptFile,
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

  private launcher(): Launcher {
    const testCli = this.testCli();
    if (testCli) return testCli;
    const resolved = resolveCli(this.config.cliPath);
    return resolved.ok ? { command: resolved.command, prefixArgs: [] } : { error: resolved.message };
  }

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

  testApi(): GhostlineTestApi {
    return {
      provider: this.provider,
      today: () => this.usage.today(),
      statusText: () => {
        this.render();
        return this.statusBar.text;
      },
      logLines: () => [...this.logLines],
      exampleCount: () => this.examples.count(),
      confirmExamples: () => this.learning.confirmPending(),
      recent: () => this.recent.list(),
      checkEdits: () => this.edits.check(),
      pendingEdit: () => this.edits.proposal,
      shownNote: () => this.notes.text,
      commitMessageFor: (files, recent) => this.commits.ask({ files, excluded: 0, recent }),
      systemPrompt: async () => {
        if (this.config.symbolContext) await this.indexer.scan();
        this.refreshProjectContext();
        return fs.readFileSync(this.systemPromptFile, 'utf8');
      },
      adaptiveReport: () => this.adaptive.report(),
      refreshCount: () => this.refreshes,
      config: () => this.config,
      styleProfile: () => this.style.profile,
      learnStyleFrom: (paths) => this.style.learnFrom(paths.map((file) => vscode.Uri.file(file))),
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

  private scanProject(): void {
    if (!this.config.enabled || !this.config.symbolContext) return;
    void this.indexer.scan().then(
      () => this.refreshProjectContext(),
      (error: unknown) => this.log(`índice del proyecto: no se pudo leer (${error instanceof Error ? error.message : String(error)})`),
    );
  }

  private indexFile(uri: vscode.Uri): void {
    if (!this.config.symbolContext || !this.indexer.ready || !isIndexable(uri.fsPath)) return;
    void this.indexer.update(uri).then((changed) => {
      if (changed) this.refreshProjectContext();
    });
  }

  private refreshProjectContext(): void {
    const { config } = this;
    const bundled = this.context.asAbsolutePath(
      path.join('resources', config.reasoning === 'adaptive' ? 'system-prompt-adaptive.txt' : 'system-prompt.txt'),
    );
    const index = config.enabled && config.symbolContext ? this.indexer.index(vscode.window.activeTextEditor?.document.uri) : undefined;
    const block = index ? projectBlock(index) : '';
    const source = `${bundled}\n${block}`;
    if (source === this.systemPromptSource) return;
    this.systemPromptSource = source;
    let file = bundled;
    if (block && index) {
      try {
        const folder = (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
        fs.mkdirSync(folder, { recursive: true });
        file = path.join(folder, 'system-prompt.txt');
        fs.writeFileSync(file, fs.readFileSync(bundled, 'utf8').trimEnd() + '\n' + block);
        this.log(
          `índice del proyecto: ${index.files} archivos, ${index.declarations} declaraciones, ` +
            `~${Math.round(block.length / this.estimator.charsPerToken)} tokens` +
            (index.omitted > 0 ? ` (${index.omitted} archivos más no caben)` : ''),
        );
      } catch (error) {
        this.log(`índice del proyecto: no se pudo escribir (${error instanceof Error ? error.message : String(error)}); se sigue sin él`);
        file = bundled;
      }
    }
    this.projectChars = file === bundled ? 0 : block.length;
    this.systemPromptFile = file;
    if (this.pool) this.resetPool();
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
    if (usesApiKey(info.apiKeySource)) this.noteApiKey(info.apiKeySource);
    this.queueRender();
  }

  private noteApiKey(source: string): void {
    if (this.warnedKeySources.has(source)) return;
    this.warnedKeySources.add(source);
    this.log(`la CLI se autentica con una API key (${source}): cada sugerencia se factura por uso.`);
    if (this.context.globalState.get<string>(API_KEY_NOTICE_KEY) === source) return;
    void vscode.window
      .showInformationMessage(
        `ghostline: la CLI se autentica con una API key (${source}), así que cada sugerencia se factura por uso. ` +
          'Lo gastado hoy está en la barra de estado.',
        'Entendido',
        'Pausar ghostline',
      )
      .then((choice) => {
        if (choice === 'Pausar ghostline' && !this.paused) this.togglePause();
        if (choice === 'Entendido') void this.context.globalState.update(API_KEY_NOTICE_KEY, source);
      });
  }

  private warnAboutEndpoint(): void {
    const host = endpointOverride(process.env);
    if (!host || this.context.globalState.get<string>(ENDPOINT_ACK_KEY) === host) return;
    const key = `endpoint:${host}`;
    if (this.warnedKeySources.has(key)) return;
    this.warnedKeySources.add(key);
    this.log(`AVISO: ANTHROPIC_BASE_URL está definida: la CLI envía las peticiones y la sesión a ${host}, no a Anthropic.`);
    void vscode.window
      .showWarningMessage(
        `ghostline: la variable de entorno ANTHROPIC_BASE_URL hace que la CLI de Claude Code envíe las peticiones, y tu sesión, a ${host} ` +
          'en lugar de a Anthropic. Si no la has definido tú, pausa ghostline y revisa tu entorno.',
        'Pausar ghostline',
        'Es mi servidor',
      )
      .then((choice) => {
        if (choice === 'Pausar ghostline' && !this.paused) this.togglePause();
        if (choice === 'Es mi servidor') void this.context.globalState.update(ENDPOINT_ACK_KEY, host);
      });
  }

  private onConfigChange(event: vscode.ConfigurationChangeEvent): void {
    if (!affectsGhostline(event)) return;
    this.config = readConfig();
    this.excludedCache.clear();
    this.provider.clearCache();
    if (affectsPool(event) || !this.config.enabled) this.resetPool();
    if (this.config.symbolContext) this.scanProject();
    this.refreshProjectContext();
    this.warnAboutPatterns();
    this.queueRender();
  }

  private warnAboutPatterns(): void {
    const unusable = unusablePatterns(this.config.excludePatterns);
    if (unusable.length === 0) return;
    this.log(`AVISO: patrones de exclusión demasiado complejos, no se aplican: ${unusable.join(' · ')}`);
    void vscode.window.showWarningMessage(
      `ghostline: ${unusable.length} patrón(es) de "ghostline.excludePatterns" son demasiado complejos y no se aplican. ` +
        'Simplifícalos (menos de 200 caracteres y de 64 alternativas entre llaves).',
    );
  }

  private onTrouble(message: string, pauseMs: number): void {
    const seconds = Math.round(pauseMs / 1000);
    this.log(`sugerencias automáticas en pausa ${seconds} s tras errores repetidos: ${message}`);
    if (!this.shownTroubles.has(message)) {
      this.shownTroubles.add(message);
      void vscode.window
        .showWarningMessage(
          `ghostline: la CLI de Claude Code está fallando (${message.slice(0, 200)}). ` +
            'Las sugerencias automáticas se reanudan solas cuando vuelva a responder; la invocación manual sigue disponible.',
          'Abrir el log',
        )
        .then((choice) => {
          if (choice) this.channel.show(true);
        });
    }
    this.queueRender();
    setTimeout(() => this.queueRender(), pauseMs + 200).unref();
  }

  private onDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    if (event.contentChanges.length > 0) {
      this.edits.documentChanged(event.document);
      this.notes.documentChanged(event.document);
    }
    if (event.contentChanges.length === 0 || event.reason !== undefined) return;
    if (event.document !== vscode.window.activeTextEditor?.document) return;
    this.provider.noteKeystroke(event.document.uri.toString(), typedInsertionEnd(event.contentChanges));
    if (!this.config.enabled || this.paused) return;
    const { scheme } = event.document.uri;
    if (scheme !== 'file' && scheme !== 'untitled') return;
    if (this.isExcluded(event.document)) return;
    this.getPool()?.warm();
  }

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

  private async clearLearning(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      'ghostline: ¿borrar los ejemplos aceptados y el perfil de estilo de este proyecto, y reactivar los contextos silenciados?',
      { modal: true },
      'Borrar',
    );
    if (choice !== 'Borrar') return;
    this.examples.clear();
    this.recent.clear();
    this.adaptive.clear();
    await this.style.clear();
    this.render();
  }

  private async showRecent(): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ content: formatRecent(this.recent.list()), language: 'plaintext' });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private maybeWarnSlow(): void {
    if (this.config.reasoning !== 'minimal') return;
    const day = this.usage.today();
    if (day.latencies.length < MIN_REQUESTS_FOR_SPEED_WARNING) return;
    const { p50 } = this.usage.latency(day);
    if (p50 === undefined || p50 <= SLOW_P50_MS) return;
    if (this.context.globalState.get<string>(SPEED_WARNING_KEY) === day.date) return;
    void this.context.globalState.update(SPEED_WARNING_KEY, day.date);
    this.log(`aviso de velocidad: la latencia mediana de hoy es de ${Math.round(p50)} ms`);
    const manual = 'Pasar a modo manual';
    const smaller = 'Reducir el contexto';
    const options = this.config.triggerMode === 'manual' ? [smaller] : [manual, smaller];
    void vscode.window
      .showInformationMessage(
        `ghostline: las sugerencias están tardando ${Math.round(p50)} ms de mediana hoy (lo normal es menos de 1 s).`,
        ...options,
      )
      .then(async (choice) => {
        if (choice === manual) await setTriggerMode('manual');
        if (choice === smaller) {
          await updateSetting('context.prefixLines', Math.max(10, Math.round(this.config.prefixLines / 2)));
          await updateSetting('context.suffixLines', Math.round(this.config.suffixLines / 2));
        }
      });
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
      { label: '$(history) Últimas sugerencias', description: 'qué se ofreció y qué pasó con ello', run: () => this.showRecent() },
      { label: '$(trash) Reiniciar contadores', run: () => this.resetCounters() },
      {
        label: '$(mortar-board) Aprender estilo del proyecto',
        description: this.style.profile ? 'vuelve a generar el perfil' : 'aún no hay perfil',
        run: () => this.style.learn(),
      },
      ...(this.style.profile ? [{ label: '$(edit) Editar el perfil de estilo', run: () => this.style.edit() }] : []),
      {
        label: '$(clear-all) Borrar lo aprendido en este proyecto',
        description: `${this.examples.count()} ejemplos`,
        run: () => this.clearLearning(),
      },
      { label: '$(gear) Ajustes de ghostline', run: () => this.openSettings() },
    ];
    const picked = await vscode.window.showQuickPick(actions, { title: 'ghostline', placeHolder: plainStatus(this.statusBar.text) });
    await picked?.run();
  }

  private openSettings(): Thenable<unknown> {
    return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:cristianemek.ghostline');
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
      this.statusBar.text = `${MARK} $(circle-slash)`;
      this.statusBar.tooltip = 'ghostline está desactivado ("ghostline.enabled": false).';
      this.statusBar.accessibilityInformation = { label: 'ghostline, desactivado' };
      this.statusBar.backgroundColor = undefined;
      return;
    }
    const day = this.usage.today();
    const session: SessionInfo = {
      triggerMode: config.triggerMode,
      paused: this.paused,
      limitReached: this.usage.overDailyLimit(config.dailyRequestLimit),
      dailyLimit: config.dailyRequestLimit,
      apiKeySource: this.init?.apiKeySource,
      cliError: this.cliError,
      rateLimit: this.rateLimit,
      sessionSpentUsd: this.usage.spentSince(sessionStart(this.rateLimit, Date.now())),
      sessionBudgetUsd: config.claudeSessionUsd,
      trouble: this.provider.trouble,
      muted: this.adaptive
        .report()
        .filter((entry) => entry.mutedUntil !== undefined)
        .map((entry) => `${entry.languageId} ${CONTEXT_LABELS[entry.context]}`),
    };
    this.statusBar.text = statusText(day, session);
    this.statusBar.accessibilityInformation = { label: plainStatus(this.statusBar.text) };
    const tooltip = new vscode.MarkdownString(tooltipMarkdown(day, session), true);
    tooltip.supportHtml = true;
    tooltip.isTrusted = { enabledCommands: TOOLTIP_COMMANDS };
    this.statusBar.tooltip = tooltip;
    this.statusBar.backgroundColor = session.cliError
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : session.limitReached || session.trouble
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
  }

  private removeStaleCwds(): void {
    const day = 24 * 3600_000;
    removeStaleWorkFolders(path.join(this.context.globalStorageUri.fsPath, WORK_FOLDERS), WORK_FOLDER_PREFIX, this.cwd, day);
    removeStaleWorkFolders(os.tmpdir(), LEGACY_CWD_PREFIX, this.cwd, day);
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
