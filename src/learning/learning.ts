import type { LearningHooks, PromptExtras, SuggestionInfo } from '../completion/hooks';
import type { TriggerContext } from '../completion/trigger';
import type { AdaptiveTrigger } from './adaptiveTrigger';
import { DEFAULT_SELECT, type ExampleStore } from './exampleStore';

export interface LearningDeps {
  examples: ExampleStore;
  adaptive: AdaptiveTrigger;
  styleProfile(): string | undefined;
  settings(): { learningExamples: boolean; adaptiveTrigger: boolean };
  charsPerToken(): number;
  onMuted?(languageId: string, context: TriggerContext): void;
  readDocument(documentKey: string): string | undefined;
  later?(task: () => void, ms: number): void;
}

export const EXAMPLE_SURVIVAL_MS = 10 * 60_000;

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const CONTEXT_LABELS: Record<TriggerContext, string> = {
  'after-dot': 'tras «.»',
  'after-paren': 'tras «(»',
  'new-line': 'en línea nueva',
  'end-of-line': 'al final de línea',
  'mid-line': 'en mitad de línea',
};

export class Learning implements LearningHooks {
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

  onShown(): void {}

  onAccepted(suggestion: SuggestionInfo): void {
    if (this.deps.settings().learningExamples) this.keepIfItStays(suggestion);
    this.recordOutcome(suggestion, true);
  }

  confirmPending(): void {
    for (const check of [...this.pending]) check();
  }

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
    if (suggestion.manual) return;
    const muted = this.deps.adaptive.record(suggestion.languageId, suggestion.context, accepted);
    if (muted && this.deps.settings().adaptiveTrigger) this.deps.onMuted?.(suggestion.languageId, suggestion.context);
  }
}
