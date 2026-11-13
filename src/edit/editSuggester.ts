import * as vscode from 'vscode';
import { totalInputTokens } from '../cli/streamParser';
import type { WorkerPool } from '../cli/workerPool';
import type { GhostlineConfig } from '../config';
import { DEFAULT_LIMITS } from '../completion/promptBuilder';
import type { RecentEntry } from '../usage/recent';
import type { TokenEstimator } from '../usage/tokenEstimator';
import type { UsageTracker } from '../usage/usageTracker';
import { buildFixPrompt, diffLines, fixRegion, hunkPreview, parseFix, type FixRegion, type Hunk, type Problem } from './fix';

export interface EditDeps {
  getConfig(): GhostlineConfig;
  getPool(): WorkerPool | null;
  isPaused(): boolean;
  isExcluded(document: vscode.TextDocument): boolean;
  completionBusy(): boolean;
  lastTyped(document: vscode.TextDocument): { line: number; at: number } | undefined;
  usage: UsageTracker;
  estimator: TokenEstimator;
  log(line: string): void;
  onActivity(): void;
  journal?: { add(entry: RecentEntry): void; resolve(id: number, outcome: string): void };
}

export interface Proposal {
  id: number;
  documentKey: string;
  documentVersion: number;
  region: FixRegion;
  newLines: string[];
}

const IDLE_MS = 1500;
const RECENT_TYPING_MS = 6000;
const MAX_REMEMBERED = 100;
const CONTEXT_KEY = 'ghostline.editVisible';
const FIRST_ID = 100_000;

export class EditSuggester {
  private readonly removed = vscode.window.createTextEditorDecorationType({
    textDecoration: 'line-through',
    backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
    opacity: '0.75',
  });
  private readonly added = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 1em',
      color: new vscode.ThemeColor('editorGhostText.foreground'),
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
      fontStyle: 'italic',
    },
  });
  private timer: NodeJS.Timeout | undefined;
  private asking: AbortController | null = null;
  private current: (Proposal & { editor: vscode.TextEditor }) | null = null;
  private statusMessage: vscode.Disposable | undefined;
  private readonly asked = new Set<string>();
  private nextId = FIRST_ID;

  constructor(private readonly deps: EditDeps) {}

  get proposal(): Proposal | undefined {
    if (!this.current) return undefined;
    const { id, documentKey, documentVersion, region, newLines } = this.current;
    return { id, documentKey, documentVersion, region, newLines };
  }

  schedule(delayMs: number = IDLE_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, delayMs);
    this.timer.unref();
  }

  documentChanged(document: vscode.TextDocument): void {
    if (this.current?.documentKey === document.uri.toString()) this.dismiss('el código cambió');
    this.asking?.abort();
    this.schedule();
  }

  selectionChanged(editor: vscode.TextEditor): void {
    const shown = this.current;
    if (shown && shown.editor === editor) {
      const line = editor.selection.active.line;
      if (line < shown.region.startLine - 2 || line > shown.region.endLine + 2) this.dismiss('el cursor se fue a otra parte');
    }
    this.schedule();
  }

  diagnosticsChanged(uris: readonly vscode.Uri[]): void {
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    if (active && uris.some((uri) => uri.toString() === active)) this.schedule();
  }

  editorChanged(): void {
    this.dismiss('se cambió de archivo');
    this.asking?.abort();
    this.schedule();
  }

  async accept(): Promise<boolean> {
    const shown = this.current;
    if (!shown) return false;
    const { editor, region, newLines, id } = shown;
    const { document } = editor;
    if (document.version !== shown.documentVersion || region.endLine >= document.lineCount) {
      this.dismiss('el código cambió');
      return false;
    }
    this.clear();
    const range = new vscode.Range(region.startLine, 0, region.endLine, document.lineAt(region.endLine).text.length);
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const applied = await editor.edit((builder) => builder.replace(range, newLines.join(eol)));
    if (applied) {
      const lastLine = region.startLine + newLines.length - 1;
      const end = new vscode.Position(lastLine, (newLines.at(-1) ?? '').length);
      editor.selection = new vscode.Selection(end, end);
      this.deps.usage.recordAccepted();
      this.deps.journal?.resolve(id, 'aceptada');
      this.deps.log(`corrección #${id} → aplicada`);
    }
    this.deps.onActivity();
    return applied;
  }

  dismiss(reason = 'descartada'): void {
    const shown = this.current;
    if (!shown) return;
    this.clear();
    this.deps.journal?.resolve(shown.id, 'descartada');
    this.deps.log(`corrección #${shown.id} → descartada (${reason})`);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.asking?.abort();
    this.clear();
    this.removed.dispose();
    this.added.dispose();
  }

  async check(): Promise<void> {
    const { deps } = this;
    const config = deps.getConfig();
    const editor = vscode.window.activeTextEditor;
    if (!editor || this.current || this.asking) return;
    if (!config.enabled || !config.corrections || config.triggerMode !== 'auto' || deps.isPaused()) return;
    const { document } = editor;
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return;
    if (deps.isExcluded(document) || config.disabledLanguages.includes(document.languageId)) return;
    if (deps.completionBusy()) {
      this.schedule();
      return;
    }

    const problems: Problem[] = vscode.languages
      .getDiagnostics(document.uri)
      .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error)
      .map((diagnostic) => ({ line: diagnostic.range.start.line, message: diagnostic.message }));
    const region = fixRegion((line) => document.lineAt(line).text, document.lineCount, problems, editor.selection.active.line);
    if (!region) return;

    const typed = deps.lastTyped(document);
    if (typed && typed.line >= region.startLine && typed.line <= region.endLine) {
      const since = Date.now() - typed.at;
      if (since < RECENT_TYPING_MS) {
        this.schedule(RECENT_TYPING_MS - since + 100);
        return;
      }
    }

    const oldLines: string[] = [];
    for (let line = region.startLine; line <= region.endLine; line++) oldLines.push(document.lineAt(line).text);
    const inRegion = problems.filter((problem) => problem.line >= region.startLine && problem.line <= region.endLine);
    const key = `${document.uri.toString()}\n${oldLines.join('\n')}\n${inRegion.map((problem) => problem.message).join('\n')}`;
    if (this.asked.has(key)) return;
    if (this.asked.size >= MAX_REMEMBERED) this.asked.clear();
    this.asked.add(key);

    if (deps.usage.overDailyLimit(config.dailyRequestLimit)) return;
    const pool = deps.getPool();
    if (!pool) return;

    const end = document.lineAt(region.endLine).range.end;
    const firstLine = Math.max(0, region.startLine - config.prefixLines);
    const lastLine = Math.min(document.lineCount - 1, region.endLine + config.suffixLines);
    const prompt = buildFixPrompt({
      path: vscode.workspace.getWorkspaceFolder(document.uri) ? vscode.workspace.asRelativePath(document.uri, false) : 'file',
      languageId: document.languageId,
      before: document.getText(new vscode.Range(firstLine, 0, region.startLine, 0)).replace(/\r\n/g, '\n'),
      region: oldLines.join('\n'),
      after: document.getText(new vscode.Range(end, document.lineAt(lastLine).range.end)).replace(/\r\n/g, '\n'),
      problems: inRegion,
      regionStartLine: region.startLine,
      limits: {
        ...DEFAULT_LIMITS,
        prefixLines: config.prefixLines,
        suffixLines: config.suffixLines,
        targetTokens: Math.max(300, 1900 - deps.estimator.overheadTokens),
        charsPerToken: deps.estimator.charsPerToken,
      },
    });

    const id = this.nextId++;
    const version = document.version;
    const controller = new AbortController();
    this.asking = controller;
    try {
      const outcome = await pool.request(prompt.text, {
        signal: controller.signal,
        timeoutMs: config.requestTimeoutMs,
        shouldStop: (text) => text.split('\n').length > oldLines.length + 14,
      });
      deps.usage.recordRequest({ status: outcome.status, usage: outcome.usage, costUsd: outcome.costUsd, totalMs: outcome.totalMs, sample: false });
      const where = `${document.languageId} · líneas ${region.startLine + 1}–${region.endLine + 1} · ${inRegion.length} errores`;
      const numbers = `entrada ${totalInputTokens(outcome.usage)}, salida ${outcome.usage.outputTokens} · ${Math.round(outcome.totalMs)} ms`;
      if (outcome.status !== 'ok') {
        deps.log(`corrección #${id} ${where} · ${numbers} · ${outcome.status === 'cancelled' ? 'cancelada' : outcome.status}`);
        return;
      }
      const newLines = parseFix(outcome.text, oldLines, document.languageId);
      const stillThere = document.version === version && vscode.window.activeTextEditor === editor;
      deps.journal?.add({
        id,
        at: Date.now(),
        file: vscode.workspace.asRelativePath(document.uri, false),
        languageId: document.languageId,
        context: 'corrección',
        manual: false,
        before: oldLines.join('\n'),
        after: '',
        raw: outcome.text,
        shown: newLines && stillThere ? newLines.join('\n') : '',
        hints: [`${inRegion.length} errores`],
        outcome: !newLines ? 'vacía' : stillThere ? 'mostrada' : 'llegó tarde y no se usó',
        inputTokens: totalInputTokens(outcome.usage),
        thinkingTokens: outcome.usage.thinkingTokens,
        totalMs: outcome.totalMs,
      });
      if (!newLines || !stillThere) {
        deps.log(`corrección #${id} ${where} · ${numbers} · ${newLines ? 'llegó tarde y no se usó' : 'sin propuesta'}`);
        return;
      }
      deps.log(`corrección #${id} ${where} · ${numbers} · ${newLines.length} líneas propuestas`);
      this.show({ id, editor, documentKey: document.uri.toString(), documentVersion: version, region, newLines }, oldLines);
    } finally {
      if (this.asking === controller) this.asking = null;
      deps.onActivity();
    }
  }

  private show(proposal: Proposal & { editor: vscode.TextEditor }, oldLines: readonly string[]): void {
    const { editor, region, newLines } = proposal;
    const { document } = editor;
    const hover = new vscode.MarkdownString();
    hover.appendMarkdown('**ghostline** propone esta corrección — `Tab` la aplica, `Esc` la descarta\n');
    hover.appendCodeblock(newLines.join('\n'), document.languageId);
    const removed: vscode.DecorationOptions[] = [];
    const added: vscode.DecorationOptions[] = [];
    for (const hunk of diffLines(oldLines, newLines)) {
      for (let offset = 0; offset < hunk.oldCount; offset++) {
        const line = document.lineAt(region.startLine + hunk.oldStart + offset);
        removed.push({ range: new vscode.Range(line.lineNumber, line.firstNonWhitespaceCharacterIndex, line.lineNumber, line.text.length), hoverMessage: hover });
      }
      added.push(this.addedAfter(document, region, hunk, hover));
    }
    this.current = proposal;
    editor.setDecorations(this.removed, removed);
    editor.setDecorations(this.added, added);
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);
    this.statusMessage = vscode.window.setStatusBarMessage('$(lightbulb) ghostline: corrección propuesta · Tab la aplica · Esc la descarta');
    this.deps.usage.recordShown();
  }

  private addedAfter(document: vscode.TextDocument, region: FixRegion, hunk: Hunk, hover: vscode.MarkdownString): vscode.DecorationOptions {
    const anchor = Math.max(0, region.startLine + hunk.oldStart + Math.max(hunk.oldCount, 0) - 1);
    const end = document.lineAt(Math.min(anchor, document.lineCount - 1)).range.end;
    const arrow = hunk.oldCount > 0 ? '→' : '⏎';
    return { range: new vscode.Range(end, end), hoverMessage: hover, renderOptions: { after: { contentText: `${arrow} ${hunkPreview(hunk)}` } } };
  }

  private clear(): void {
    const shown = this.current;
    this.current = null;
    if (shown) {
      shown.editor.setDecorations(this.removed, []);
      shown.editor.setDecorations(this.added, []);
    }
    this.statusMessage?.dispose();
    this.statusMessage = undefined;
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
  }
}
