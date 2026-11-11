import { createHash } from 'node:crypto';

/** Small LRU cache with a time-to-live per entry. */
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
    // Re-insert so the entry becomes the most recently used.
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

/** Cache key: the file plus what immediately surrounds the cursor. */
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
  /** Offset of the cursor when the suggestion was shown. */
  offset: number;
  /** Text right before that offset, to notice edits made elsewhere. */
  tail: string;
  text: string;
  id: number;
}

export interface TypeaheadMatch {
  /** What is left of the suggestion after what the user has typed. */
  rest: string;
  typed: string;
  id: number;
}

/**
 * Remembers the last suggestion shown. While the user types exactly its first characters, the rest
 * is served from here: no request, zero tokens.
 */
export class Typeahead {
  private last: Remembered | null = null;

  remember(documentKey: string, offset: number, textBeforeCursor: string, suggestion: string, id: number): void {
    this.last = { documentKey, offset, tail: textBeforeCursor.slice(-TAIL_CHARS), text: suggestion, id };
  }

  /**
   * @param offset current cursor offset
   * @param read returns the document text between two offsets
   */
  match(documentKey: string, offset: number, read: (start: number, end: number) => string): TypeaheadMatch | null {
    const last = this.last;
    if (!last || last.documentKey !== documentKey || offset < last.offset) return null;
    const typedLength = offset - last.offset;
    if (typedLength >= last.text.length) return null;
    if (read(last.offset - last.tail.length, last.offset) !== last.tail) return null;
    const typed = read(last.offset, offset);
    if (!last.text.startsWith(typed)) return null;
    return { rest: last.text.slice(typed.length), typed, id: last.id };
  }

  /** Id of the suggestion currently remembered, if any. */
  get currentId(): number | null {
    return this.last?.id ?? null;
  }

  clear(): void {
    this.last = null;
  }
}
