import type { LearningHooks, PromptExtras, SuggestionInfo } from '../completion/hooks';
import type { TriggerContext } from '../completion/trigger';
import type { AdaptiveTrigger } from './adaptiveTrigger';
import { DEFAULT_SELECT, type ExampleStore } from './exampleStore';

export interface LearningDeps {
  examples: ExampleStore;
  adaptive: AdaptiveTrigger;
  /** The style guide to send as the stable block, already capped; undefined when there is none. */
  styleProfile(): string | undefined;
  settings(): { learningExamples: boolean; adaptiveTrigger: boolean };
  charsPerToken(): number;
  /** A language/context pair has just been muted for 24 hours. */
  onMuted?(languageId: string, context: TriggerContext): void;
  /** Current text of a document, or undefined when it is no longer open. */
  readDocument(documentKey: string): string | undefined;
  /** Runs `task` after `ms`. A timer by default; tests pass their own. */
  later?(task: () => void, ms: number): void;
}

/**
 * How long an accepted suggestion must stay in the file before it becomes an example. Accepting is
 * not approving: a wrong suggestion taken with Tab and fixed by hand afterwards would, as an
 * example, teach the model the same mistake.
 */
export const EXAMPLE_SURVIVAL_MS = 10 * 60_000;

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const CONTEXT_LABELS: Record<TriggerContext, string> = {
  'after-dot': 'tras «.»',
  'after-paren': 'tras «(»',
  'new-line': 'en línea nueva',
  'end-of-line': 'al final de línea',
  'mid-line': 'en mitad de línea',
};

/**
 * Adapts ghostline to the user without training anything. Everything it knows lives in the
 * editor's local storage.
 */
export class Learning implements LearningHooks {
  /** Accepted suggestions waiting to see whether they stay in the file. */
  private pending: Array<() => void> = [];

  constructor(private readonly deps: LearningDeps) {}

  isSuppressed(languageId: string, context: TriggerContext): boolean {
    return this.deps.settings().adaptiveTrigger && this.deps.adaptive.isSuppressed(languageId, context);
  }

  promptExtras(languageId: string, before: string): PromptExtras {
    const { deps } = this;
    return {
      styleProfile: deps.styleProfile(),
      examples: deps.settings().learningExamples
        ? deps.examples.select(languageId, before, { ...DEFAULT_SELECT, charsPerToken: deps.charsPerToken() })
        : undefined,
    };
  }

  onShown(): void {
    // Nothing to learn until the suggestion is accepted or passed over.
  }

  onAccepted(suggestion: SuggestionInfo): void {
    if (this.deps.settings().learningExamples) this.keepIfItStays(suggestion);
    this.recordOutcome(suggestion, true);
  }

  /** Checks right away the accepted suggestions that are still waiting (window closing, tests). */
  confirmPending(): void {
    for (const check of [...this.pending]) check();
  }

  /**
   * An accepted suggestion becomes an example only if, a while later, its text is still in the
   * file (spacing aside: a formatter may have realigned it). One that was edited or removed was not
   * what the user wanted, and must not be shown to the model as if it were.
   */
  private keepIfItStays(suggestion: SuggestionInfo): void {
    const check = (): void => {
      if (!this.pending.includes(check)) return;
      this.pending = this.pending.filter((other) => other !== check);
      const document = this.deps.readDocument(suggestion.documentKey);
      if (document === undefined || !squash(document).includes(squash(suggestion.text))) return;
      this.deps.examples.add(suggestion.languageId, suggestion.before, suggestion.text);
    };
    this.pending.push(check);
    const later = this.deps.later ?? ((task: () => void, ms: number): void => void setTimeout(task, ms).unref());
    later(check, EXAMPLE_SURVIVAL_MS);
  }

  onIgnored(suggestion: SuggestionInfo): void {
    this.recordOutcome(suggestion, false);
  }

  private recordOutcome(suggestion: SuggestionInfo, accepted: boolean): void {
    // Only automatic suggestions say something about when it is worth triggering automatically.
    if (suggestion.manual) return;
    const muted = this.deps.adaptive.record(suggestion.languageId, suggestion.context, accepted);
    if (muted && this.deps.settings().adaptiveTrigger) this.deps.onMuted?.(suggestion.languageId, suggestion.context);
  }
}
