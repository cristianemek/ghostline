import * as vscode from 'vscode';
import { totalInputTokens } from '../cli/streamParser';
import type { CompletionOutcome, WorkerPool } from '../cli/workerPool';
import type { GhostlineConfig } from '../config';
import type { TokenEstimator } from '../usage/tokenEstimator';
import { summaryLine } from '../usage/report';
import { formatRequestLine, type RequestLogEntry } from '../usage/requestLog';
import type { UsageTracker } from '../usage/usageTracker';
import { LruCache, Typeahead, completionKey, type DocumentReader } from './cache';
import { postprocess, shouldStopEarly, trimAgainstSuffix, type IndentStyle } from './postprocess';
import { DEFAULT_LIMITS, buildPrompt, type PromptExample } from './promptBuilder';
import { TypingRate, classifyContext, cursorAllowsAuto, debounceDelay, wait, type TriggerContext } from './trigger';

export const ACCEPT_COMMAND = 'ghostline._accepted';

const MAX_DOCUMENT_CHARS = 1_000_000;
/**
 * Total input tokens to aim for per request, as the CLI reports them. The spec's acceptance bar is a
 * median of 2.000; aiming a little under leaves room for estimation error.
 */
const TARGET_TOTAL_INPUT_TOKENS = 1900;
const MIN_FILE_TOKENS = 300;
/** A latency/usage summary goes to the log every this many successful requests. */
const SUMMARY_EVERY = 20;
/** Lines kept as the "before" context of a suggestion (5 previous lines + the current one). */
const BEFORE_LINES = 6;

/** A suggestion that reached the editor, as the learning layer sees it. */
export interface SuggestionInfo {
  id: number;
  documentKey: string;
  languageId: string;
  context: TriggerContext;
  manual: boolean;
  /** The lines right before the cursor when it was shown. */
  before: string;
  text: string;
}

export interface PromptExtras {
  styleProfile?: string;
  examples?: PromptExample[];
}

/** Phase 2 plugs in here; without it the provider behaves as plain Phase 1. */
export interface LearningHooks {
  /** True when automatic suggestions are muted for this language and cursor context. */
  isSuppressed(languageId: string, context: TriggerContext): boolean;
  promptExtras(languageId: string, before: string): PromptExtras;
  onShown(suggestion: SuggestionInfo): void;
  onAccepted(suggestion: SuggestionInfo): void;
  onIgnored(suggestion: SuggestionInfo): void;
}

/** Phase 3: signature lines for symbols on the current line. */
export type SymbolProvider = (
  document: vscode.TextDocument,
  position: vscode.Position,
  signal: AbortSignal,
) => Promise<string[]>;

export interface ProviderDeps {
  getConfig(): GhostlineConfig;
  /** Null when the CLI cannot be located. */
  getPool(): WorkerPool | null;
  isPaused(): boolean;
  isExcluded(document: vscode.TextDocument): boolean;
  usage: UsageTracker;
  estimator: TokenEstimator;
  log(line: string): void;
  /** Something the status bar shows has changed. */
  onActivity(): void;
  learning?: LearningHooks;
  symbols?: SymbolProvider;
}

interface LiveSuggestion extends SuggestionInfo {
  documentVersion: number;
  /** Cursor offset the last time it was served. */
  offset: number;
  /** Log line of the request that produced it, written once the outcome is known. */
  logEntry: RequestLogEntry | null;
}

function readerFor(document: vscode.TextDocument): DocumentReader {
  return (start, end) =>
    document.getText(new vscode.Range(document.positionAt(start), document.positionAt(end))).replace(/\r\n/g, '\n');
}

function indentStyleOf(document: vscode.TextDocument): IndentStyle {
  const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.document === document);
  const insertSpaces = editor?.options.insertSpaces;
  const tabSize = editor?.options.tabSize;
  if (typeof insertSpaces === 'boolean' && typeof tabSize === 'number') return { insertSpaces, tabSize };
  const settings = vscode.workspace.getConfiguration('editor', document);
  return { insertSpaces: settings.get<boolean>('insertSpaces', true), tabSize: settings.get<number>('tabSize', 4) };
}

function documentChars(document: vscode.TextDocument): number {
  return document.offsetAt(document.lineAt(document.lineCount - 1).range.end);
}

function lastLines(text: string, count: number): string {
  return text.split('\n').slice(-count).join('\n');
}

export class GhostlineProvider implements vscode.InlineCompletionItemProvider {
  private readonly cache = new LruCache<string>();
  private readonly typeahead = new Typeahead();
  private readonly typing = new TypingRate();
  private live: LiveSuggestion | null = null;
  private nextId = 1;

  constructor(private readonly deps: ProviderDeps) {}

  /** Call on every edit that looks like typing. */
  noteKeystroke(): void {
    this.typing.record(Date.now());
  }

  /** The item's command ran: the suggestion was accepted. */
  accepted(id: number): void {
    if (this.live?.id === id) this.resolveLive('aceptada');
  }

  /** The cursor moved without an edit: whatever was showing has been dismissed. */
  cursorMoved(document: vscode.TextDocument, position: vscode.Position): void {
    const live = this.live;
    if (!live || live.documentKey !== document.uri.toString()) return;
    // An edit is followed by a new provider call, which settles the suggestion itself.
    if (live.documentVersion !== document.version) return;
    if (document.offsetAt(position) === live.offset) return;
    this.resolveLive('ignorada');
  }

  /** Editor switched, extension paused… */
  dismiss(): void {
    this.resolveLive('ignorada');
  }

  clearCache(): void {
    this.cache.clear();
    this.typeahead.clear();
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const { deps } = this;
    const config = deps.getConfig();
    if (!config.enabled) return undefined;
    const manual = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
    if (!manual && (config.triggerMode === 'manual' || deps.isPaused())) return undefined;

    // Hard gates, manual mode included: never touch sensitive, foreign or huge documents.
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return undefined;
    if (deps.isExcluded(document)) return undefined;
    if (documentChars(document) >= MAX_DOCUMENT_CHARS) return undefined;

    const documentKey = document.uri.toString();
    const languageId = document.languageId;
    const offset = document.offsetAt(position);
    const read = readerFor(document);
    const lineText = document.lineAt(position.line).text;
    const linePrefix = lineText.slice(0, position.character);
    const restOfLine = lineText.slice(position.character);
    const triggerContext = classifyContext(linePrefix);
    const indent = indentStyleOf(document);

    const firstLine = Math.max(0, position.line - config.prefixLines);
    const lastLine = Math.min(document.lineCount - 1, position.line + config.suffixLines);
    const prefix = document.getText(new vscode.Range(firstLine, 0, position.line, position.character)).replace(/\r\n/g, '\n');
    const suffix = document
      .getText(new vscode.Range(position, document.lineAt(lastLine).range.end))
      .replace(/\r\n/g, '\n');

    // 1. Typeahead: the user is typing what was suggested. Serve the rest locally, zero tokens.
    const ahead = this.typeahead.match(documentKey, offset, read);
    if (ahead && this.live?.id === ahead.id) {
      const rest = trimAgainstSuffix(ahead.rest, prefix, suffix, indent);
      if (rest.trim()) {
        if (ahead.typed) deps.usage.recordLocalHit();
        this.live.documentVersion = document.version;
        this.live.offset = offset;
        return [this.item(rest, position, ahead.id)];
      }
      // The whole suggestion is now in the document: accepted with Tab (this call can race with the
      // accept command) or typed out by hand. Either way it was what the user wanted.
      this.resolveLive('aceptada');
    }
    // Anything else means the previous suggestion, if any, was not taken.
    this.resolveLive('ignorada');

    // 2. Rules that only apply to automatic triggering.
    if (!manual) {
      if (config.disabledLanguages.includes(languageId)) return undefined;
      if (!cursorAllowsAuto(restOfLine)) return undefined;
      // The IntelliSense popup is open: an inline suggestion would be hidden behind it anyway.
      if (context.selectedCompletionInfo) return undefined;
      if (config.adaptiveTrigger && deps.learning?.isSuppressed(languageId, triggerContext)) return undefined;
    }

    const before = lastLines(prefix, BEFORE_LINES);
    const describe = (id: number, text: string): SuggestionInfo => ({
      id,
      documentKey,
      languageId,
      context: triggerContext,
      manual,
      before,
      text,
    });

    // 3. Cache: same file, same surroundings, asked less than five minutes ago.
    const key = completionKey(documentKey, prefix, suffix);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      if (!cached) return undefined;
      deps.usage.recordLocalHit();
      return [this.show(document, position, read, describe(this.nextId++, cached), null)];
    }

    if (!manual && deps.usage.overDailyLimit(config.dailyRequestLimit)) {
      deps.onActivity();
      return undefined;
    }
    const pool = deps.getPool();
    if (!pool) return undefined;
    pool.warm();

    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try {
      // 4. Debounce. The symbol lookup (Phase 3) runs meanwhile, so it adds no latency.
      const symbolsPending =
        config.symbolContext && deps.symbols
          ? deps.symbols(document, position, controller.signal).catch(() => [])
          : Promise.resolve<string[]>([]);
      if (!manual) {
        const delay = debounceDelay(config.debounceMs, this.typing.isFast(Date.now()));
        if (!(await wait(delay, controller.signal))) return undefined;
      }
      const symbols = await symbolsPending;
      if (controller.signal.aborted) return undefined;

      // 5. Prompt, sized so that the request's total input stays on target.
      const { estimator } = deps;
      const extras = deps.learning?.promptExtras(languageId, before) ?? {};
      const built = buildPrompt({
        path: document.isUntitled ? 'untitled' : vscode.workspace.asRelativePath(document.uri, false),
        languageId,
        prefix,
        suffix,
        styleProfile: extras.styleProfile,
        examples: config.learningExamples ? extras.examples : undefined,
        symbols,
        limits: {
          ...DEFAULT_LIMITS,
          prefixLines: config.prefixLines,
          suffixLines: config.suffixLines,
          fileTargetTokens: Math.max(MIN_FILE_TOKENS, TARGET_TOTAL_INPUT_TOKENS - estimator.overheadTokens),
          charsPerToken: estimator.charsPerToken,
        },
      });

      // 6. Request.
      const id = this.nextId++;
      const outcome = await pool.request(built.text, {
        signal: controller.signal,
        timeoutMs: config.requestTimeoutMs,
        shouldStop: (text) => shouldStopEarly(text, { maxLines: config.maxLines, prefix: built.prefix, languageId }),
      });
      const logEntry = this.account(id, outcome, built.chars, languageId, triggerContext, manual);
      if (config.logPrompts) {
        deps.log(`#${id} prompt (${built.chars} caracteres, ~${built.estimatedTokens} tokens):\n${built.text}`);
        deps.log(`#${id} respuesta (${outcome.status}): ${JSON.stringify(outcome.text)}`);
      }
      if (outcome.status !== 'ok') {
        const detail = outcome.status === 'error' ? `error: ${outcome.errorMessage ?? 'desconocido'}` : outcome.status;
        deps.log(formatRequestLine(logEntry, detail === 'cancelled' ? 'cancelada' : detail));
        return undefined;
      }

      // 7. Clean up the answer.
      const text = postprocess({
        raw: outcome.text,
        prefix: built.prefix,
        suffix: built.suffix,
        maxLines: config.maxLines,
        indent,
        languageId,
      });
      this.cache.set(key, text);
      if (!text) {
        deps.log(formatRequestLine(logEntry, 'vacía'));
        return undefined;
      }
      if (token.isCancellationRequested) {
        // Too late for this keystroke, but it stays cached for the next time the cursor is here.
        deps.log(formatRequestLine(logEntry, 'llegó tarde (en caché)'));
        return undefined;
      }
      return [this.show(document, position, read, describe(id, text), logEntry)];
    } finally {
      subscription.dispose();
    }
  }

  /** Flushes the pending log line. */
  dispose(): void {
    this.resolveLive('sin resolver');
  }

  private account(
    id: number,
    outcome: CompletionOutcome,
    promptChars: number,
    languageId: string,
    context: TriggerContext,
    manual: boolean,
  ): RequestLogEntry {
    const { deps } = this;
    deps.usage.recordRequest({
      status: outcome.status,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      totalMs: outcome.totalMs,
    });
    // Only clean single-round requests teach the estimator: a CLI retry doubles the input tokens.
    if (outcome.status === 'ok' && !outcome.usagePartial && outcome.numTurns <= 1) {
      deps.estimator.observe(promptChars, totalInputTokens(outcome.usage));
    }
    if (outcome.status === 'ok') {
      const day = deps.usage.today();
      if (day.latencies.length % SUMMARY_EVERY === 0) {
        deps.log(summaryLine(day, deps.usage.latency(day), deps.usage.medianInputTokens(day)));
      }
    }
    deps.onActivity();
    return {
      id,
      time: new Date(),
      languageId,
      context,
      manual,
      waitForWorkerMs: outcome.waitForWorkerMs,
      firstTokenMs: outcome.firstTokenMs,
      totalMs: outcome.totalMs,
      usage: outcome.usage,
      usagePartial: outcome.usagePartial,
    };
  }

  private show(
    document: vscode.TextDocument,
    position: vscode.Position,
    read: DocumentReader,
    suggestion: SuggestionInfo,
    logEntry: RequestLogEntry | null,
  ): vscode.InlineCompletionItem {
    const offset = document.offsetAt(position);
    this.live = { ...suggestion, documentVersion: document.version, offset, logEntry };
    this.typeahead.remember(suggestion.documentKey, offset, read, suggestion.text, suggestion.id);
    this.deps.usage.recordShown();
    this.deps.learning?.onShown(suggestion);
    this.deps.onActivity();
    return this.item(suggestion.text, position, suggestion.id);
  }

  private item(text: string, position: vscode.Position, id: number): vscode.InlineCompletionItem {
    return new vscode.InlineCompletionItem(text, new vscode.Range(position, position), {
      title: 'ghostline: sugerencia aceptada',
      command: ACCEPT_COMMAND,
      arguments: [id],
    });
  }

  private resolveLive(outcome: 'aceptada' | 'ignorada' | 'sin resolver'): void {
    const live = this.live;
    if (!live) return;
    this.live = null;
    this.typeahead.clear();
    const { deps } = this;
    if (outcome === 'aceptada') {
      deps.usage.recordAccepted();
      deps.learning?.onAccepted(live);
    } else if (outcome === 'ignorada') {
      deps.learning?.onIgnored(live);
    }
    if (live.logEntry) deps.log(formatRequestLine(live.logEntry, `${live.text.split('\n').length} líneas → ${outcome}`));
    deps.onActivity();
  }
}
