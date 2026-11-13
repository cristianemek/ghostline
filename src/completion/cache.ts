import { createHash } from 'node:crypto';

export class LruCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 200,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export function completionKey(path: string, prefix: string, suffix: string): string {
  return createHash('sha1')
    .update(path)
    .update('\0')
    .update(prefix.slice(-500))
    .update('\0')
    .update(suffix.slice(0, 200))
    .digest('base64');
}

const TAIL_CHARS = 200;

interface Remembered {
  documentKey: string;
  offset: number;
  tail: string;
  text: string;
  id: number;
}

export interface TypeaheadMatch {
  rest: string;
  typed: string;
  id: number;
}

export type DocumentReader = (start: number, end: number) => string;

export class Typeahead {
  private last: Remembered | null = null;

  remember(documentKey: string, offset: number, read: DocumentReader, suggestion: string, id: number): void {
    this.last = { documentKey, offset, tail: read(Math.max(0, offset - TAIL_CHARS), offset), text: suggestion, id };
  }

  match(documentKey: string, offset: number, read: DocumentReader): TypeaheadMatch | null {
    const last = this.last;
    if (!last || last.documentKey !== documentKey || offset < last.offset) return null;
    if (read(Math.max(0, last.offset - TAIL_CHARS), last.offset) !== last.tail) return null;
    const typed = read(last.offset, offset);
    if (!last.text.startsWith(typed)) return null;
    return { rest: last.text.slice(typed.length), typed, id: last.id };
  }

  get currentId(): number | null {
    return this.last?.id ?? null;
  }

  clear(): void {
    this.last = null;
  }
}
