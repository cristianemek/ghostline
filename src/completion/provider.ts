import { basename } from 'node:path';
import * as vscode from 'vscode';
import { totalInputTokens } from '../cli/streamParser';
import type { CompletionOutcome, WorkerPool } from '../cli/workerPool';
import type { GhostlineConfig } from '../config';
import type { SymbolLine } from '../context/symbolText';
import type { RecentEntry } from '../usage/recent';
import type { TokenEstimator } from '../usage/tokenEstimator';
import { summaryLine } from '../usage/report';
import { formatRequestLine, type RequestLogEntry } from '../usage/requestLog';
import type { UsageTracker } from '../usage/usageTracker';
import { FailureBreaker } from './breaker';
import { LruCache, Typeahead, completionKey, type DocumentReader } from './cache';
import type { LearningHooks, SuggestionInfo } from './hooks';
import { insertionFromLine, insertionSoFar, postprocess, shouldStopEarly, trimAgainstSuffix, type IndentStyle } from './postprocess';
import { DEFAULT_LIMITS, buildPrompt } from './promptBuilder';
import {
  TypingRate,
  agreesWithTyping,
  classifyContext,
  cursorAllowsAuto,
  debounceDelay,
  eagerDelay,
  midLineAllowsAuto,
  wait,
  type TriggerContext,
} from './trigger';

export const ACCEPT_COMMAND = 'ghostline._accepted';

const MAX_DOCUMENT_CHARS = 1_000_000;
const TARGET_TOTAL_INPUT_TOKENS = 1900;
const MIN_FILE_TOKENS = 300;
const SUMMARY_EVERY = 20;
const BEFORE_LINES = 6;
const TAIL_CHARS = 200;
const AFTER_ACCEPT_MS = 400;
const SENT_TO_API_MS = 150;
const REFRESH_WINDOW_MS = 1000;

export type SymbolProvider = (
  document: vscode.TextDocument,
  position: vscode.Position,
  signal: AbortSignal,
) => Promise<SymbolLine[]>;

export interface SuggestionJournal {
  add(entry: RecentEntry): void;
  resolve(id: number, outcome: string): void;
}

export interface ProviderDeps {
  getConfig(): GhostlineConfig;
  getPool(): WorkerPool | null;
  isPaused(): boolean;
  isExcluded(document: vscode.TextDocument): boolean;
  usage: UsageTracker;
  estimator: TokenEstimator;
  log(line: string): void;
  onActivity(): void;
  onTrouble?(message: string, pauseMs: number): void;
  refresh?(documentKey: string): void;
  learning?: LearningHooks;
  symbols?: SymbolProvider;
  journal?: SuggestionJournal;
  projectContextChars?(): number;
}

interface LiveSuggestion extends SuggestionInfo {
  shownAt: number;
  documentVersion: number;
  offset: number;
  logEntry: RequestLogEntry | null;
}

interface Arrival {
  suggestion: SuggestionInfo;
  anchor: number;
  tail: string;
  logEntry: RequestLogEntry | null;
}

interface Flight {
  documentKey: string;
  documentVersion: number;
  anchor: number;
  tail: string;
  lineWasBlank: boolean;
  lineBefore: string | undefined;
  partial: string;
  onPartial: Set<() => void>;
  controller: AbortController;
  waiting: number;
  done: Promise<Arrival | null>;
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

function promptPath(document: vscode.TextDocument): string {
  if (document.isUntitled) return 'untitled';
  return vscode.workspace.getWorkspaceFolder(document.uri)
    ? vscode.workspace.asRelativePath(document.uri, false)
    : basename(document.uri.fsPath);
}

function documentChars(document: vscode.TextDocument): number {
  return document.offsetAt(document.lineAt(document.lineCount - 1).range.end);
}

function lastLines(text: string, count: number): string {
  return text.split('\n').slice(-count).join('\n');
}

interface Place {
  document: vscode.TextDocument;
  position: vscode.Position;
  documentKey: string;
  offset: number;
  read: DocumentReader;
  prefix: string;
  suffix: string;
  indent: IndentStyle;
}

export class GhostlineProvider implements vscode.InlineCompletionItemProvider {
  private readonly cache = new LruCache<string>();
  private readonly typeahead = new Typeahead();
  private readonly typing = new TypingRate();
  private readonly breaker = new FailureBreaker();
  private live: LiveSuggestion | null = null;
  private flight: Flight | null = null;
  private arrived: Arrival | null = null;
  private acceptedAt = 0;
  private refreshAt = 0;
  private typedAt: { documentKey: string; offset: number } | null = null;
  private edits = 0;
  private afterAccept: { documentKey: string; edits: number; tail: string } | null = null;
  private nextId = 1;
  minVisibleMs = 750;

  constructor(private readonly deps: ProviderDeps) {}

  get trouble(): { remainingMs: number; reason: string } | undefined {
    return this.breaker.open ? { remainingMs: this.breaker.remainingMs, reason: this.breaker.reason ?? '' } : undefined;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    try {
      return await this.provide(document, position, context, token);
    } catch (error) {
      this.deps.log(`ERROR interno: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      return undefined;
    }
  }

  noteKeystroke(documentKey?: string, typedEnd?: number): void {
    this.typing.record(Date.now());
    this.edits++;
    this.typedAt = documentKey !== undefined && typedEnd !== undefined ? { documentKey, offset: typedEnd } : null;
    if (this.typedAt) this.lastTyped = { ...this.typedAt, at: Date.now() };
  }

  get busy(): boolean {
    return this.live !== null || this.flight !== null || this.arrived !== null;
  }

  lastTyped: { documentKey: string; offset: number; at: number } | null = null;

  accepted(id: number): void {
    if (this.live?.id === id) this.resolveLive('aceptada');
  }

  cursorMoved(document: vscode.TextDocument, position: vscode.Position): void {
    const documentKey = document.uri.toString();
    const offset = document.offsetAt(position);
    const flight = this.flight;
    if (flight && flight.documentKey === documentKey && flight.documentVersion === document.version && offset !== flight.anchor) {
      this.abortFlight();
    }
    if (this.arrived && this.arrived.suggestion.documentKey === documentKey && offset < this.arrived.anchor) this.dropArrived();
    const live = this.live;
    if (!live || live.documentKey !== documentKey) return;
    if (live.documentVersion !== document.version) return;
    if (offset === live.offset) return;
    this.resolveLive('ignorada');
  }

  dismiss(): void {
    this.abortFlight();
    this.dropArrived();
    this.resolveLive('ignorada');
  }

  clearCache(): void {
    this.cache.clear();
    this.typeahead.clear();
    this.dropArrived();
  }

  private async provide(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const { deps } = this;
    const calledAt = Date.now();
    const config = deps.getConfig();
    if (!config.enabled) return undefined;
    const refresh =
      context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke && Date.now() - this.refreshAt < REFRESH_WINDOW_MS;
    if (refresh) this.refreshAt = 0;
    const manual = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke && !refresh;
    if (!manual && !refresh && (config.triggerMode === 'manual' || deps.isPaused())) return undefined;

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
    const triggerContext = classifyContext(linePrefix, restOfLine);
    const codeAfter = !cursorAllowsAuto(restOfLine);
    const indent = indentStyleOf(document);

    const firstLine = Math.max(0, position.line - config.prefixLines);
    const lastLine = Math.min(document.lineCount - 1, position.line + config.suffixLines);
    const prefix = document.getText(new vscode.Range(firstLine, 0, position.line, position.character)).replace(/\r\n/g, '\n');
    const suffix = document
      .getText(new vscode.Range(position, document.lineAt(lastLine).range.end))
      .replace(/\r\n/g, '\n');
    const place: Place = { document, position, documentKey, offset, read, prefix, suffix, indent };

    const ahead = this.typeahead.match(documentKey, offset, read);
    if (ahead && this.live?.id === ahead.id) {
      const rest = trimAgainstSuffix(ahead.rest, prefix, suffix, indent);
      if (rest.trim()) {
        if (ahead.typed) deps.usage.recordLocalHit();
        this.live.documentVersion = document.version;
        this.live.offset = offset;
        return [this.item(rest, position, ahead.id)];
      }
      this.resolveLive('aceptada');
    }
    this.resolveLive('ignorada');

    if (this.arrived) {
      const arrival = this.arrived;
      this.arrived = null;
      const shown = this.present(arrival, place);
      if (shown) return shown;
    }

    let waited = false;
    const flight = this.flight;
    if (flight) {
      if (this.flightStillFits(flight, place)) {
        const arrival = await this.waitFor(flight, token, () => this.flightStillFits(flight, place));
        if (arrival === 'cancelled') return undefined;
        if (arrival === 'diverged') {
          this.abortFlight();
        } else if (arrival) {
          const shown = this.present(arrival, place);
          if (shown) return shown;
        }
        waited = true;
      } else {
        this.abortFlight();
      }
    }
    if (refresh || token.isCancellationRequested) return undefined;

    if (!manual) {
      if (config.disabledLanguages.includes(languageId)) return undefined;
      const taken = this.afterAccept;
      if (
        config.speculation === 'off' &&
        taken !== null &&
        taken.documentKey === documentKey &&
        taken.edits === this.edits &&
        linePrefix.endsWith(taken.tail)
      ) {
        return undefined;
      }
      if (codeAfter) {
        const justTyped = this.typedAt?.documentKey === documentKey && this.typedAt.offset === offset;
        if (!config.midLine || !justTyped || !midLineAllowsAuto(linePrefix, restOfLine)) return undefined;
      }
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

    const key = completionKey(documentKey, prefix, suffix);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      if (!cached) return undefined;
      deps.usage.recordLocalHit();
      return this.present({ suggestion: describe(this.nextId++, cached), anchor: offset, tail: read(Math.max(0, offset - TAIL_CHARS), offset), logEntry: null }, place);
    }

    if (!manual && (deps.usage.overDailyLimit(config.dailyRequestLimit) || this.breaker.open)) {
      deps.onActivity();
      return undefined;
    }
    const pool = deps.getPool();
    if (!pool) return undefined;
    pool.warm();

    const waiter = new AbortController();
    const subscription = token.onCancellationRequested(() => waiter.abort());
    if (token.isCancellationRequested) waiter.abort();
    let symbols: SymbolLine[];
    try {
      let symbolsPending: Promise<SymbolLine[]> = Promise.resolve([]);
      const lookUpSymbols = (): void => {
        if (config.symbolContext && deps.symbols) symbolsPending = deps.symbols(document, position, waiter.signal).catch(() => []);
      };
      const delay = manual ? 0 : Math.max(0, this.delayFor(config, linePrefix) - (waited ? Date.now() - calledAt : 0));
      if (delay > 0) {
        if (!(await wait(delay / 2, waiter.signal))) return undefined;
        lookUpSymbols();
        if (!(await wait(delay / 2, waiter.signal))) return undefined;
      } else {
        lookUpSymbols();
      }
      symbols = await symbolsPending;
      if (waiter.signal.aborted) return undefined;
    } finally {
      subscription.dispose();
    }

    const { estimator } = deps;
    const extras = deps.learning?.promptExtras(languageId, before) ?? {};
    const built = buildPrompt({
      path: promptPath(document),
      languageId,
      prefix,
      suffix,
      styleProfile: extras.styleProfile,
      examples: config.learningExamples ? extras.examples : undefined,
      symbols: symbols.map((symbol) => symbol.line),
      limits: {
        ...DEFAULT_LIMITS,
        prefixLines: config.prefixLines,
        suffixLines: config.suffixLines,
        targetTokens: Math.max(MIN_FILE_TOKENS, TARGET_TOTAL_INPUT_TOKENS - estimator.overheadTokens),
        charsPerToken: estimator.charsPerToken,
      },
    });

    const id = this.nextId++;
    const singleLine = restOfLine.trim() !== '';
    const launched: Flight = {
      documentKey,
      documentVersion: document.version,
      anchor: offset,
      tail: read(Math.max(0, offset - TAIL_CHARS), offset),
      lineWasBlank: linePrefix.trim() === '',
      lineBefore: built.line?.before,
      partial: '',
      onPartial: new Set(),
      controller: new AbortController(),
      waiting: 0,
      done: Promise.resolve(null),
    };
    this.abortFlight();
    this.flight = launched;
    launched.done = (async (): Promise<Arrival | null> => {
      const outcome = await pool.request(built.text, {
        signal: launched.controller.signal,
        timeoutMs: config.requestTimeoutMs,
        shouldStop: (text) => {
          launched.partial = text;
          for (const notify of launched.onPartial) notify();
          if (singleLine && /\S[^\n]*\n/.test(text)) return true;
          return shouldStopEarly(text, { maxLines: config.maxLines, prefix: built.prefix, languageId });
        },
      });
      if (this.flight === launched) this.flight = null;
      const logEntry = this.account(id, outcome, built.chars, languageId, triggerContext, manual);
      logEntry.hints = [
        ...(built.styleUsed ? ['estilo'] : []),
        ...(built.examplesUsed > 0 ? [`${built.examplesUsed} ej.`] : []),
        ...(built.symbolsUsed > 0
          ? [`símbolos: ${symbols.slice(0, built.symbolsUsed).map((symbol) => symbol.name).join(', ')}`]
          : []),
        ...((deps.projectContextChars?.() ?? 0) > 0 ? ['índice'] : []),
      ];
      if (config.logPrompts) {
        deps.log(`#${id} prompt (${built.chars} caracteres, ~${built.estimatedTokens} tokens):\n${built.text}`);
        deps.log(`#${id} respuesta (${outcome.status}): ${JSON.stringify(outcome.text)}`);
      }
      if (outcome.status !== 'ok') {
        const detail = outcome.status === 'error' ? `error: ${outcome.errorMessage ?? 'desconocido'}` : outcome.status;
        deps.log(formatRequestLine(logEntry, detail === 'cancelled' ? 'cancelada' : detail));
        if (outcome.status !== 'cancelled') {
          const message = outcome.errorMessage ?? 'la CLI no respondió a tiempo';
          const pauseMs = this.breaker.failure(message);
          if (pauseMs > 0) deps.onTrouble?.(message, pauseMs);
        }
        return null;
      }
      this.breaker.success();

      const answer = singleLine ? (/^\s*\S[^\n]*/.exec(outcome.text)?.[0] ?? '') : outcome.text;
      let text = postprocess({
        raw: built.line ? insertionFromLine(outcome.text, built.line.before, built.line.after) : answer,
        prefix: built.prefix,
        suffix: built.suffix,
        maxLines: config.maxLines,
        indent,
        languageId,
      });
      if (codeAfter) {
        text = text.split('\n')[0] ?? '';
        if (!text.trim()) text = '';
      }
      deps.journal?.add({
        id,
        at: Date.now(),
        file: promptPath(document),
        languageId,
        context: triggerContext,
        manual,
        before: linePrefix,
        after: restOfLine,
        raw: outcome.text,
        shown: text,
        hints: logEntry.hints ?? [],
        outcome: text ? 'sin resolver' : 'vacía',
        inputTokens: totalInputTokens(outcome.usage),
        thinkingTokens: outcome.usage.thinkingTokens,
        totalMs: outcome.totalMs,
      });
      this.cache.set(key, text);
      if (!text) {
        deps.log(formatRequestLine(logEntry, 'vacía'));
        return null;
      }
      const arrival: Arrival = { suggestion: describe(id, text), anchor: launched.anchor, tail: launched.tail, logEntry };
      if (launched.waiting === 0) {
        this.dropArrived();
        this.arrived = arrival;
        this.refreshAt = Date.now();
        deps.refresh?.(documentKey);
        return null;
      }
      return arrival;
    })();

    const arrival = await this.waitFor(launched, token);
    if (arrival === 'cancelled' || arrival === 'diverged' || !arrival) return undefined;
    return this.present(arrival, place);
  }

  dispose(): void {
    this.abortFlight();
    this.dropArrived();
    this.resolveLive('sin resolver');
  }

  private delayFor(config: GhostlineConfig, linePrefix: string): number {
    const now = Date.now();
    const full = debounceDelay(config.debounceMs, this.typing.isFast(now));
    if (config.speculation === 'off') return full;
    if (now - this.acceptedAt < AFTER_ACCEPT_MS) return 0;
    if (linePrefix.trim() === '') return eagerDelay(config.debounceMs, config.eagerDebounceMs, this.typing.medianGap(now));
    return full;
  }

  private flightStillFits(flight: Flight, place: Place): boolean {
    if (flight.documentKey !== place.documentKey || place.offset < flight.anchor) return false;
    if (place.read(Math.max(0, flight.anchor - TAIL_CHARS), flight.anchor) !== flight.tail) return false;
    const inserting = flight.lineBefore === undefined ? flight.partial : insertionSoFar(flight.partial, flight.lineBefore);
    if (inserting === null) return false;
    return agreesWithTyping(inserting, place.read(flight.anchor, place.offset), flight.lineWasBlank);
  }

  private async waitFor(
    flight: Flight,
    token: vscode.CancellationToken,
    stillFits?: () => boolean,
  ): Promise<Arrival | null | 'cancelled' | 'diverged'> {
    if (token.isCancellationRequested) return 'cancelled';
    flight.waiting++;
    let subscription: vscode.Disposable | undefined;
    const cancelled = new Promise<'cancelled'>((resolve) => {
      subscription = token.onCancellationRequested(() => {
        flight.waiting--;
        resolve('cancelled');
      });
    });
    let listener: (() => void) | undefined;
    const diverged = new Promise<'diverged'>((resolve) => {
      if (!stillFits) return;
      listener = () => {
        if (!stillFits()) resolve('diverged');
      };
      flight.onPartial.add(listener);
    });
    try {
      return await Promise.race([flight.done, cancelled, diverged]);
    } finally {
      subscription?.dispose();
      if (listener) flight.onPartial.delete(listener);
    }
  }

  private abortFlight(): void {
    const flight = this.flight;
    if (!flight) return;
    this.flight = null;
    flight.controller.abort();
  }

  private dropArrived(): void {
    const arrival = this.arrived;
    if (!arrival) return;
    this.arrived = null;
    if (arrival.logEntry) this.deps.log(formatRequestLine(arrival.logEntry, 'llegó tarde y no se usó'));
    this.deps.journal?.resolve(arrival.suggestion.id, 'llegó tarde y no se usó');
  }

  private present(arrival: Arrival, place: Place): vscode.InlineCompletionItem[] | undefined {
    const { suggestion, anchor } = arrival;
    const { deps } = this;
    const fits =
      suggestion.documentKey === place.documentKey &&
      place.offset >= anchor &&
      place.read(Math.max(0, anchor - TAIL_CHARS), anchor) === arrival.tail;
    const typed = fits ? place.read(anchor, place.offset) : '';
    const rest = fits && suggestion.text.startsWith(typed)
      ? trimAgainstSuffix(suggestion.text.slice(typed.length), place.prefix, place.suffix, place.indent)
      : '';
    if (!rest.trim()) {
      if (arrival.logEntry) deps.log(formatRequestLine(arrival.logEntry, 'llegó tarde y no se usó'));
      deps.journal?.resolve(suggestion.id, 'llegó tarde y no se usó');
      return undefined;
    }
    deps.journal?.resolve(suggestion.id, 'mostrada');
    this.live = {
      ...suggestion,
      documentVersion: place.document.version,
      offset: place.offset,
      logEntry: arrival.logEntry,
      shownAt: Date.now(),
    };
    this.typeahead.remember(suggestion.documentKey, anchor, place.read, suggestion.text, suggestion.id);
    if (typed) deps.usage.recordLocalHit();
    deps.usage.recordShown();
    deps.learning?.onShown(suggestion);
    deps.onActivity();
    return [this.item(rest, place.position, suggestion.id)];
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
    const projectTokens = Math.round((deps.projectContextChars?.() ?? 0) / deps.estimator.charsPerToken);
    if (outcome.status !== 'ok' && outcome.usage.inputTokens === 0 && outcome.totalMs > SENT_TO_API_MS) {
      deps.usage.recordUnconfirmed(deps.estimator.estimateTotal(promptChars) + projectTokens);
    }
    if (outcome.status === 'ok' && !outcome.usagePartial && outcome.numTurns <= 1) {
      deps.estimator.observe(promptChars, Math.max(1, totalInputTokens(outcome.usage) - projectTokens));
    }
    if (outcome.status === 'ok') {
      const day = deps.usage.today();
      if (day.latencies.length % SUMMARY_EVERY === 0) {
        deps.log(summaryLine(day, deps.usage.latency(day), deps.usage.medianInputTokens(day), deps.getConfig().reasoning === 'minimal'));
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
    let label: string = outcome;
    if (outcome === 'aceptada') {
      this.acceptedAt = Date.now();
      this.typedAt = null;
      this.afterAccept = { documentKey: live.documentKey, edits: this.edits, tail: live.text.slice(live.text.lastIndexOf('\n') + 1) };
      deps.usage.recordAccepted();
      deps.learning?.onAccepted(live);
    } else if (outcome === 'ignorada') {
      if (Date.now() - live.shownAt < this.minVisibleMs) label = 'descartada al instante';
      else deps.learning?.onIgnored(live);
    }
    if (live.logEntry) deps.log(formatRequestLine(live.logEntry, `${live.text.split('\n').length} líneas → ${label}`));
    deps.journal?.resolve(live.id, label);
    deps.onActivity();
  }
}
