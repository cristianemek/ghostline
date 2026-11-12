import type { KeyValueStore } from './usageTracker';

/**
 * One answered request, kept to look back at how the suggestions are doing: what was on the line,
 * what the model said, what was offered and what became of it. Local to the workspace, like the
 * accepted examples; never anything from an excluded file, where no request is ever made.
 */
export interface RecentEntry {
  /** Request number within the window that made it. */
  id: number;
  /** Epoch ms. */
  at: number;
  /** Path as the model saw it. */
  file: string;
  languageId: string;
  context: string;
  manual: boolean;
  /** The cursor's line up to the cursor. */
  before: string;
  /** The rest of that line. */
  after: string;
  /** The model's answer, untouched. */
  raw: string;
  /** What was offered after post-processing; empty when nothing was. */
  shown: string;
  /** What the prompt carried besides the file: "2 ej.", "símbolos: Foo, bar"… */
  hints: string[];
  outcome: string;
  inputTokens: number;
  thinkingTokens: number;
  totalMs: number;
}

const STORE_KEY = 'ghostline.recent.v1';
const MAX_ENTRIES = 40;
const MAX_LINE_CHARS = 160;
const MAX_TEXT_CHARS = 400;

function clip(text: string, max: number, fromEnd = false): string {
  if (text.length <= max) return text;
  return fromEnd ? `…${text.slice(text.length - max + 1)}` : `${text.slice(0, max - 1)}…`;
}

function isEntry(value: unknown): value is RecentEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'number' && typeof entry.at === 'number' && typeof entry.shown === 'string' && typeof entry.outcome === 'string';
}

/** The last few dozen answered requests of this workspace, newest last in storage. */
export class RecentSuggestions {
  private entries: RecentEntry[];

  constructor(private readonly store: KeyValueStore) {
    const raw = store.get<unknown>(STORE_KEY);
    this.entries = Array.isArray(raw) ? raw.filter(isEntry).slice(-MAX_ENTRIES) : [];
  }

  add(entry: RecentEntry): void {
    this.entries.push({
      ...entry,
      before: clip(entry.before, MAX_LINE_CHARS, true),
      after: clip(entry.after, MAX_LINE_CHARS),
      raw: clip(entry.raw, MAX_TEXT_CHARS),
      shown: clip(entry.shown, MAX_TEXT_CHARS),
    });
    this.entries = this.entries.slice(-MAX_ENTRIES);
    this.save();
  }

  /** Sets what became of the latest request with this number. */
  resolve(id: number, outcome: string): void {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index] as RecentEntry;
      if (entry.id !== id) continue;
      if (entry.outcome === outcome) return;
      entry.outcome = outcome;
      this.save();
      return;
    }
  }

  /** Newest first. */
  list(): RecentEntry[] {
    return [...this.entries].reverse();
  }

  clear(): void {
    this.entries = [];
    void this.store.update(STORE_KEY, undefined);
  }

  private save(): void {
    void this.store.update(STORE_KEY, this.entries);
  }
}

const visible = (text: string): string => text.replace(/\t/g, '⇥').replace(/\n/g, '⏎');

/** Plain text for the "últimas sugerencias" view. */
export function formatRecent(entries: readonly RecentEntry[]): string {
  if (entries.length === 0) return 'ghostline todavía no ha recibido ninguna respuesta en este proyecto.\n';
  const time = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const blocks = entries.map((entry) => {
    const head = [
      time.format(new Date(entry.at)),
      entry.file,
      `${entry.languageId} ${entry.context}${entry.manual ? ' (manual)' : ''}`,
      entry.outcome.toUpperCase(),
      `${entry.inputTokens} tok`,
      `${Math.round(entry.totalMs)} ms${entry.thinkingTokens > 0 ? ' (razonó)' : ''}`,
      ...entry.hints,
    ].join(' · ');
    const lines = [head, `  línea:    ${visible(entry.before)}▮${visible(entry.after)}`];
    lines.push(`  ofrecido: ${entry.shown ? visible(entry.shown) : '(nada)'}`);
    if (entry.raw.trim() !== entry.shown.trim()) lines.push(`  modelo:   ${visible(entry.raw)}`);
    return lines.join('\n');
  });
  return (
    'ghostline · últimas respuestas en este proyecto, la más reciente primero\n' +
    '(▮ cursor · ⇥ tabulador · ⏎ salto de línea · «modelo» solo aparece cuando difiere de lo ofrecido)\n\n' +
    blocks.join('\n\n') +
    '\n'
  );
}
