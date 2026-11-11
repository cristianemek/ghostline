import type { PromptExample } from './promptBuilder';
import type { TriggerContext } from './trigger';

/** A suggestion that reached the editor, as the learning layer sees it. */
export interface SuggestionInfo {
  id: number;
  documentKey: string;
  languageId: string;
  context: TriggerContext;
  /** True when the user asked for it explicitly instead of it being triggered by typing. */
  manual: boolean;
  /** The lines right before the cursor when it was shown (5 previous lines + the current one). */
  before: string;
  text: string;
}

export interface PromptExtras {
  /** Stable block: the project's style guide. */
  styleProfile?: string;
  /** Variable block: accepted completions similar to what is being typed. */
  examples?: PromptExample[];
}

/** Where Phase 2 plugs into the provider; without it the provider behaves as plain Phase 1. */
export interface LearningHooks {
  /** True when automatic suggestions are muted for this language and cursor context. */
  isSuppressed(languageId: string, context: TriggerContext): boolean;
  promptExtras(languageId: string, before: string): PromptExtras;
  onShown(suggestion: SuggestionInfo): void;
  onAccepted(suggestion: SuggestionInfo): void;
  onIgnored(suggestion: SuggestionInfo): void;
}
