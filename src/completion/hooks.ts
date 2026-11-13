import type { PromptExample } from './promptBuilder';
import type { TriggerContext } from './trigger';

export interface SuggestionInfo {
  id: number;
  documentKey: string;
  languageId: string;
  context: TriggerContext;
  manual: boolean;
  before: string;
  text: string;
}

export interface PromptExtras {
  styleProfile?: string;
  examples?: PromptExample[];
}

export interface LearningHooks {
  isSuppressed(languageId: string, context: TriggerContext): boolean;
  promptExtras(languageId: string, before: string): PromptExtras;
  onShown(suggestion: SuggestionInfo): void;
  onAccepted(suggestion: SuggestionInfo): void;
  onIgnored(suggestion: SuggestionInfo): void;
}
