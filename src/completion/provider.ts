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
/** Characters before a request's cursor remembered to notice edits made above it. */
const TAIL_CHARS = 200;
/** The provider call caused by accepting a suggestion arrives within this time. */
const AFTER_ACCEPT_MS = 400;
/** A request cancelled later than this after being sent has, in all likelihood, reached the API. */
const SENT_TO_API_MS = 150;
/** How long a programmatic refresh may take to reach the provider. */
const REFRESH_WINDOW_MS = 1000;

/** Phase 3: declarations of symbols used at the cursor. */
export type SymbolProvider = (
  document: vscode.TextDocument,
  position: vscode.Position,
  signal: AbortSignal,
) => Promise<SymbolLine[]>;

/** Where answered requests are kept for looking back at them (see usage/recent.ts). */
export interface SuggestionJournal {
  add(entry: RecentEntry): void;
  resolve(id: number, outcome: string): void;
}

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
  /** Automatic requests have just been paused for `pauseMs` after repeated failures. */
  onTrouble?(message: string, pauseMs: number): void;
  /**
   * An answer arrived after the user had typed on: ask the editor to query the provider again so it
   * can be shown now instead of at the next pause.
   */
  refresh?(documentKey: string): void;
  learning?: LearningHooks;
  symbols?: SymbolProvider;
  journal?: SuggestionJournal;
  /**
   * Characters of project index in the system prompt (0 without one). They are input tokens of every
   * request without being part of the prompt built here, so the size estimate has to know about them.
   */
  projectContextChars?(): number;
}

interface LiveSuggestion extends SuggestionInfo {
  /** When it reached the editor. */
  shownAt: number;
  documentVersion: number;
  /** Cursor offset the last time it was served. */
  offset: number;
  /** Log line of the request that produced it, written once the outcome is known. */
  logEntry: RequestLogEntry | null;
}

/** An answer that is ready, anchored to where its request was made. */
interface Arrival {
  suggestion: SuggestionInfo;
  /** Cursor offset when the request was sent. */
  anchor: number;
  /** Text right before the anchor at that moment. */
  tail: string;
  logEntry: RequestLogEntry | null;
}

/**
 * A request in the air. It is no longer killed by the next keystroke: if the user keeps typing what
 * the model is answering, the answer is still good when it lands, and it lands a whole request
 * sooner than a new one would.
 */
interface Flight {
  documentKey: string;
  documentVersion: number;
  anchor: number;
  tail: string;
  lineWasBlank: boolean;
  /**
   * Set for a request in the middle of a line: the answer is that whole line, and this is what was
   * before the cursor on it (see `insertionFromLine`).
   */
  lineBefore: string | undefined;
  /** Raw answer streamed so far. */
  partial: string;
  /** Called after every piece of the answer arrives. */
  onPartial: Set<() => void>;
  controller: AbortController;
  /** Provider calls currently waiting for it. With none, the answer is kept for the next call. */
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

/** The path shown to the model. Outside the workspace only the file name: the rest is the user's folder layout. */
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

/** What a provider call knows about where the cursor is. */
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
  /** An answer nobody was waiting for any more; shown if the typing since then agrees with it. */
  private arrived: Arrival | null = null;
  private acceptedAt = 0;
  private refreshAt = 0;
  /** Where the user's last hand-typed insertion ended; null after any other kind of edit. */
  private typedAt: { documentKey: string; offset: number } | null = null;
  /** Edits seen in the active document; tells whether anything was typed since a suggestion was taken. */
  private edits = 0;
  private afterAccept: { documentKey: string; edits: number; tail: string } | null = null;
  private nextId = 1;
  /** A suggestion dismissed sooner than this was never really seen. */
  minVisibleMs = 750;

  constructor(private readonly deps: ProviderDeps) {}

  /** Set while automatic requests are paused after repeated failures. */
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
      // A bug here must not surface as a noisy editor error on every keystroke.
      this.deps.log(`ERROR interno: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      return undefined;
    }
  }

  /**
   * Call on every edit that looks like typing. `typedEnd` is where it ended when it was a plain
   * hand-typed insertion (see `typedInsertionEnd`).
   */
  noteKeystroke(documentKey?: string, typedEnd?: number): void {
    this.typing.record(Date.now());
    this.edits++;
    this.typedAt = documentKey !== undefined && typedEnd !== undefined ? { documentKey, offset: typedEnd } : null;
    if (this.typedAt) this.lastTyped = { ...this.typedAt, at: Date.now() };
  }

  /** A suggestion is on screen or on its way: nothing else should compete for the user's attention. */
  get busy(): boolean {
    return this.live !== null || this.flight !== null || this.arrived !== null;
  }

  /** Where and when the user last typed something by hand (it outlives edits of other kinds). */
  lastTyped: { documentKey: string; offset: number; at: number } | null = null;

  /** The item's command ran: the suggestion was accepted. */
  accepted(id: number): void {
    if (this.live?.id === id) this.resolveLive('aceptada');
  }

  /** The cursor moved without an edit: whatever was showing, or on its way, is for somewhere else. */
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
    // An edit is followed by a new provider call, which settles the suggestion itself.
    if (live.documentVersion !== document.version) return;
    if (offset === live.offset) return;
    this.resolveLive('ignorada');
  }

  /** Editor switched, extension paused… */
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
    // A call we caused ourselves to show an answer that arrived late: it never starts a request.
    const refresh =
      context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke && Date.now() - this.refreshAt < REFRESH_WINDOW_MS;
    if (refresh) this.refreshAt = 0;
    const manual = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke && !refresh;
    if (!manual && !refresh && (config.triggerMode === 'manual' || deps.isPaused())) return undefined;

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
    const triggerContext = classifyContext(linePrefix, restOfLine);
    // Code (not just closing characters) follows the cursor on this line.
    const codeAfter = !cursorAllowsAuto(restOfLine);
    const indent = indentStyleOf(document);

    const firstLine = Math.max(0, position.line - config.prefixLines);
    const lastLine = Math.min(document.lineCount - 1, position.line + config.suffixLines);
    const prefix = document.getText(new vscode.Range(firstLine, 0, position.line, position.character)).replace(/\r\n/g, '\n');
    const suffix = document
      .getText(new vscode.Range(position, document.lineAt(lastLine).range.end))
      .replace(/\r\n/g, '\n');
    const place: Place = { document, position, documentKey, offset, read, prefix, suffix, indent };

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

    // 2. An answer that arrived while the user was typing on: still good if the typing agrees with it.
    if (this.arrived) {
      const arrival = this.arrived;
      this.arrived = null;
      const shown = this.present(arrival, place);
      if (shown) return shown;
    }

    // 3. A request still in the air. If what has been typed since agrees with what it is answering,
    // wait for it: it will land long before a new request would.
    let waited = false;
    const flight = this.flight;
    if (flight) {
      if (this.flightStillFits(flight, place)) {
        const arrival = await this.waitFor(flight, token, () => this.flightStillFits(flight, place));
        if (arrival === 'cancelled') return undefined;
        if (arrival === 'diverged') {
          // Its first words already differ from what was typed: no point in waiting for the rest.
          this.abortFlight();
        } else if (arrival) {
          const shown = this.present(arrival, place);
          if (shown) return shown;
        }
        // It turned out to be something else (or nothing). The user has waited already: ask at once.
        waited = true;
      } else {
        this.abortFlight();
      }
    }
    if (refresh || token.isCancellationRequested) return undefined;

    // 4. Rules that only apply to automatic triggering.
    if (!manual) {
      if (config.disabledLanguages.includes(languageId)) return undefined;
      // Right after a suggestion is taken the model has just said all it had for this spot: in real
      // use, asking again there came back empty. The next keystroke lifts this. (With speculation
      // on, that follow-up is exactly the bet that was asked for.)
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
        // In the middle of a line only right where the user has just typed something by hand: an
        // insertion in front of existing code ("conversation, |c.queries.Create(…)"). Deleting,
        // pasting or merely placing the cursor there asks for nothing.
        const justTyped = this.typedAt?.documentKey === documentKey && this.typedAt.offset === offset;
        if (!config.midLine || !justTyped || !midLineAllowsAuto(linePrefix, restOfLine)) return undefined;
      }
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

    // 5. Cache: same file, same surroundings, asked less than five minutes ago.
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

    // 6. Wait for the typing to settle. How long depends on where the cursor is: nothing right after
    // accepting a suggestion, a short wait where a suggestion is most wanted, the full debounce in
    // the middle of a word. The symbol lookup (Phase 3) shares the wait, starting halfway through so
    // that a burst of typing does not send a query per keystroke to the language server.
    const waiter = new AbortController();
    const subscription = token.onCancellationRequested(() => waiter.abort());
    if (token.isCancellationRequested) waiter.abort();
    let symbols: SymbolLine[];
    try {
      let symbolsPending: Promise<SymbolLine[]> = Promise.resolve([]);
      const lookUpSymbols = (): void => {
        if (config.symbolContext && deps.symbols) symbolsPending = deps.symbols(document, position, waiter.signal).catch(() => []);
      };
      // Time already spent waiting for a flight that turned out to be for something else counts
      // towards the pause, but does not replace it: while the user is still typing this call is
      // cancelled before the wait is over. (Asking at once instead chained three to five requests
      // per line in the typing simulation.)
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

    // 7. Prompt, sized so that the request's total input stays on target.
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

    // 8. Request. From here on it has a life of its own: this call may be cancelled by the next
    // keystroke, the request goes on until it answers or stops being useful.
    const id = this.nextId++;
    // Text after the cursor on the same line ("foo(|)"): only one line can possibly fit there.
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
        // By name: "2 símbolos" did not say whether the one that mattered was among them.
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

      // With something after the cursor on its line only one line fits. The stream is stopped there,
      // but several lines can arrive at once ("ctx, id)⏎⇥if err != nil {…"): keep up to the first one.
      const answer = singleLine ? (/^\s*\S[^\n]*/.exec(outcome.text)?.[0] ?? '') : outcome.text;
      let text = postprocess({
        // In the middle of a line the model was asked for the whole line: what it adds at the
        // cursor is the completion, and an answer that changes either side of it is not one.
        raw: built.line ? insertionFromLine(outcome.text, built.line.before, built.line.after) : answer,
        prefix: built.prefix,
        suffix: built.suffix,
        maxLines: config.maxLines,
        indent,
        languageId,
      });
      if (codeAfter) {
        // Between two pieces of code only one line fits; an answer that starts on a new line was
        // meant for somewhere else.
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
        // Nobody is waiting (the user typed on): keep it, and ask the editor to come back for it.
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

  /** Flushes the pending log line. */
  dispose(): void {
    this.abortFlight();
    this.dropArrived();
    this.resolveLive('sin resolver');
  }

  private delayFor(config: GhostlineConfig, linePrefix: string): number {
    const now = Date.now();
    const full = debounceDelay(config.debounceMs, this.typing.isFast(now));
    if (config.speculation === 'off') return full;
    // The user has just taken a suggestion: the next one is wanted now.
    if (now - this.acceptedAt < AFTER_ACCEPT_MS) return 0;
    // A new line is where a prediction pays off most: it covers the whole statement, and if the user
    // starts typing what it says, it is on screen before they pause. The same bet inside a line
    // (after ".", "(", "="…) was measured too: more tokens and no shorter wait, so it is not made.
    if (linePrefix.trim() === '') return eagerDelay(config.debounceMs, config.eagerDebounceMs, this.typing.medianGap(now));
    return full;
  }

  /** Same document, nothing edited above the request's cursor, and the typing since agrees with the answer so far. */
  private flightStillFits(flight: Flight, place: Place): boolean {
    if (flight.documentKey !== place.documentKey || place.offset < flight.anchor) return false;
    if (place.read(Math.max(0, flight.anchor - TAIL_CHARS), flight.anchor) !== flight.tail) return false;
    // What the answer would insert so far: the answer itself, or, when it is a whole line, the part
    // of it that comes after what was already before the cursor.
    const inserting = flight.lineBefore === undefined ? flight.partial : insertionSoFar(flight.partial, flight.lineBefore);
    if (inserting === null) return false;
    return agreesWithTyping(inserting, place.read(flight.anchor, place.offset), flight.lineWasBlank);
  }

  /** Waits for a flight on behalf of one provider call. The call can be cancelled; the flight cannot (by it). */
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
        // Stop counting as a waiter right away, so the answer is kept if it lands a moment later.
        // The request itself goes on: once it has reached the model its input is paid for, and
        // killing it at the next keystroke only throws the answer away.
        flight.waiting--;
        resolve('cancelled');
      });
    });
    // Someone who joined a flight started for an earlier cursor position checks each new piece of
    // the answer against what was typed since, and leaves as soon as they disagree.
    // A flight that stays silent is one where the model stopped to think. It is not abandoned for
    // that: in real use a one-second limit killed requests just before they answered (the first
    // token took ~1.1 s there), and the answers that come after thinking are the ones most often right.
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

  /**
   * Shows an answer at the current cursor: the part of it that has not been typed yet. Returns
   * undefined when what was typed since the request no longer agrees with it.
   */
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
    // Anchored where the request was made, so that typing on keeps being served from it.
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
    // Cut off before the model said anything: the CLI never got to report usage, but the request
    // had been sent. Whether it is billed is not visible from here, so it is kept apart as an
    // estimate instead of being counted as free.
    // The project index rides in the system prompt: tokens of the request, not of this prompt. Left
    // out of what the estimator learns, so that its fixed overhead stays the fixed overhead and the
    // budget for the file does not shrink by the size of the index.
    const projectTokens = Math.round((deps.projectContextChars?.() ?? 0) / deps.estimator.charsPerToken);
    if (outcome.status !== 'ok' && outcome.usage.inputTokens === 0 && outcome.totalMs > SENT_TO_API_MS) {
      deps.usage.recordUnconfirmed(deps.estimator.estimateTotal(promptChars) + projectTokens);
    }
    // Only clean single-round requests teach the estimator: a CLI retry doubles the input tokens.
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
      // What is in the document now was suggested, not typed: no follow-up request in mid-line.
      this.typedAt = null;
      this.afterAccept = { documentKey: live.documentKey, edits: this.edits, tail: live.text.slice(live.text.lastIndexOf('\n') + 1) };
      deps.usage.recordAccepted();
      deps.learning?.onAccepted(live);
    } else if (outcome === 'ignorada') {
      // Gone before anyone could read it (the user simply kept typing): that says nothing about
      // whether the suggestion was any good, so it must not count against this kind of context.
      if (Date.now() - live.shownAt < this.minVisibleMs) label = 'descartada al instante';
      else deps.learning?.onIgnored(live);
    }
    if (live.logEntry) deps.log(formatRequestLine(live.logEntry, `${live.text.split('\n').length} líneas → ${label}`));
    deps.journal?.resolve(live.id, label);
    deps.onActivity();
  }
}
