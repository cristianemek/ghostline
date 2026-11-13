import type { PromptExample } from '../completion/promptBuilder';
import type { KeyValueStore } from '../usage/usageTracker';
import { identifiers, jaccard } from './similarity';

interface StoredExample {
  before: string;
  accepted: string;
  at: number;
}

export interface SelectOptions {
  max: number;
  maxTokens: number;
  charsPerToken: number;
  minSimilarity: number;
}

export const DEFAULT_SELECT: Omit<SelectOptions, 'charsPerToken'> = { max: 2, maxTokens: 300, minSimilarity: 0.12 };

const STORE_KEY = 'ghostline.examples.v2';
const UNVERIFIED_KEY = 'ghostline.examples.v1';
const MAX_PER_LANGUAGE = 200;
const MAX_FIELD_CHARS = 600;
const EXAMPLE_WRAPPER_CHARS = 60;

function isStored(value: unknown): value is StoredExample {
  if (value === null || typeof value !== 'object') return false;
  const example = value as Record<string, unknown>;
  return typeof example.before === 'string' && typeof example.accepted === 'string' && typeof example.at === 'number';
}

export class ExampleStore {
  private byLanguage = new Map<string, StoredExample[]>();
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

  add(languageId: string, before: string, accepted: string): void {
    const text = accepted.trim();
    if (!text) return;
    const example: StoredExample = {
      before: before.slice(-MAX_FIELD_CHARS),
      accepted: accepted.slice(0, MAX_FIELD_CHARS),
      at: this.now(),
    };
    const list = (this.byLanguage.get(languageId) ?? []).filter(
      (existing) => !(existing.before === example.before && existing.accepted === example.accepted),
    );
    list.push(example);
    this.byLanguage.set(languageId, list.slice(-MAX_PER_LANGUAGE));
    void this.store.update(STORE_KEY, Object.fromEntries(this.byLanguage));
  }

  select(languageId: string, before: string, options: SelectOptions): PromptExample[] {
    const list = this.byLanguage.get(languageId);
    if (!list || list.length === 0) return [];
    const query = identifiers(before);
    if (query.size === 0) return [];

    const ranked = list
      .map((example) => ({ example, score: jaccard(query, this.signature(example)) }))
      .filter((entry) => entry.score >= options.minSimilarity)
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
