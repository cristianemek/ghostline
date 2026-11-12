import type { PromptExample } from '../completion/promptBuilder';
import type { KeyValueStore } from '../usage/usageTracker';
import { identifiers, jaccard } from './similarity';

interface StoredExample {
  /** The lines right before the cursor when the suggestion was accepted. */
  before: string;
  accepted: string;
  /** Epoch ms, newest last. */
  at: number;
}

export interface SelectOptions {
  /** How many examples to return at most. */
  max: number;
  /** Budget for all of them together. */
  maxTokens: number;
  charsPerToken: number;
  /** Below this similarity an example is noise, not a hint. */
  minSimilarity: number;
}

/**
 * 0.12 is roughly "a handful of shared identifiers between two six-line snippets": code from the same
 * area of the project. Lower than that and the examples would only add tokens.
 */
export const DEFAULT_SELECT: Omit<SelectOptions, 'charsPerToken'> = { max: 2, maxTokens: 300, minSimilarity: 0.12 };

const STORE_KEY = 'ghostline.examples.v2';
/**
 * Up to v0.8 a suggestion was stored the moment it was accepted, right or wrong. Those examples
 * cannot be told apart now, so they are dropped.
 */
const UNVERIFIED_KEY = 'ghostline.examples.v1';
const MAX_PER_LANGUAGE = 200;
const MAX_FIELD_CHARS = 600;
/** Characters the prompt adds around each example (tags and line breaks). */
const EXAMPLE_WRAPPER_CHARS = 60;

function isStored(value: unknown): value is StoredExample {
  if (value === null || typeof value !== 'object') return false;
  const example = value as Record<string, unknown>;
  return typeof example.before === 'string' && typeof example.accepted === 'string' && typeof example.at === 'number';
}

/**
 * The completions the user accepted and kept, per language, in the workspace state (local only). A
 * couple of the ones most similar to what is being typed go into each prompt as few-shot examples:
 * that is how ghostline "learns" without any model training. Off by default since v0.9: measured on
 * real calls, they made the model copy the shape of the example over the declaration in front of it.
 */
export class ExampleStore {
  private byLanguage = new Map<string, StoredExample[]>();
  /** Identifier sets, computed lazily and dropped whenever the examples change. */
  private signatures = new WeakMap<StoredExample, Set<string>>();

  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {
    if (store.get<unknown>(UNVERIFIED_KEY) !== undefined) void store.update(UNVERIFIED_KEY, undefined);
    const raw = store.get<unknown>(STORE_KEY);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [languageId, list] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(list)) this.byLanguage.set(languageId, list.filter(isStored).slice(-MAX_PER_LANGUAGE));
      }
    }
  }

  /** Remembers an accepted completion. Keeps the latest 200 per language. */
  add(languageId: string, before: string, accepted: string): void {
    const text = accepted.trim();
    if (!text) return;
    const example: StoredExample = {
      before: before.slice(-MAX_FIELD_CHARS),
      accepted: accepted.slice(0, MAX_FIELD_CHARS),
      at: this.now(),
    };
    const list = (this.byLanguage.get(languageId) ?? []).filter(
      // The same completion in the same place again replaces the older copy.
      (existing) => !(existing.before === example.before && existing.accepted === example.accepted),
    );
    list.push(example);
    this.byLanguage.set(languageId, list.slice(-MAX_PER_LANGUAGE));
    void this.store.update(STORE_KEY, Object.fromEntries(this.byLanguage));
  }

  /** The stored examples most similar (Jaccard over identifiers) to the code before the cursor. */
  select(languageId: string, before: string, options: SelectOptions): PromptExample[] {
    const list = this.byLanguage.get(languageId);
    if (!list || list.length === 0) return [];
    const query = identifiers(before);
    if (query.size === 0) return [];

    const ranked = list
      .map((example) => ({ example, score: jaccard(query, this.signature(example)) }))
      .filter((entry) => entry.score >= options.minSimilarity)
      // Most similar first; among equals, the most recent.
      .sort((a, b) => b.score - a.score || b.example.at - a.example.at);

    const picked: PromptExample[] = [];
    let budget = options.maxTokens * options.charsPerToken;
    for (const { example } of ranked) {
      if (picked.length >= options.max) break;
      const cost = example.before.length + example.accepted.length + EXAMPLE_WRAPPER_CHARS;
      if (cost > budget) continue;
      budget -= cost;
      picked.push({ before: example.before, accepted: example.accepted });
    }
    return picked;
  }

  count(languageId?: string): number {
    if (languageId !== undefined) return this.byLanguage.get(languageId)?.length ?? 0;
    let total = 0;
    for (const list of this.byLanguage.values()) total += list.length;
    return total;
  }

  clear(): void {
    this.byLanguage.clear();
    void this.store.update(STORE_KEY, undefined);
  }

  private signature(example: StoredExample): Set<string> {
    let signature = this.signatures.get(example);
    if (!signature) {
      signature = identifiers(`${example.before}\n${example.accepted}`);
      this.signatures.set(example, signature);
    }
    return signature;
  }
}
