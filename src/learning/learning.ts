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
}

export const CONTEXT_LABELS: Record<TriggerContext, string> = {
  'after-dot': 'tras «.»',
  'after-paren': 'tras «(»',
  'new-line': 'en línea nueva',
  'end-of-line': 'al final de línea',
  'mid-line': 'en mitad de línea',
};

/**
 * Phase 2: adapts ghostline to the user without training anything. Everything it knows lives in the
 * editor's local storage.
 */
export class Learning implements LearningHooks {
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
    if (this.deps.settings().learningExamples) {
      this.deps.examples.add(suggestion.languageId, suggestion.before, suggestion.text);
    }
    this.recordOutcome(suggestion, true);
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
