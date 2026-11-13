import type { TriggerContext } from '../completion/trigger';
import type { KeyValueStore } from '../usage/usageTracker';

interface ContextState {
  outcomes: string;
  mutedUntil?: number;
}

export interface ContextReport {
  languageId: string;
  context: TriggerContext;
  shown: number;
  accepted: number;
  mutedUntil?: number;
}

const STORE_KEY = 'ghostline.adaptive.v1';
const WINDOW = 40;
const MIN_ACCEPTANCE = 0.1;
const MUTE_MS = 24 * 3600_000;

function isState(value: unknown): value is ContextState {
  if (value === null || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return typeof state.outcomes === 'string' && /^[01]*$/.test(state.outcomes);
}

export class AdaptiveTrigger {
  private states = new Map<string, ContextState>();

  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {
    const raw = store.get<unknown>(STORE_KEY);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (isState(value)) {
          const mutedUntil = (value as { mutedUntil?: unknown }).mutedUntil;
          this.states.set(key, {
            outcomes: value.outcomes.slice(-WINDOW),
            mutedUntil: typeof mutedUntil === 'number' ? mutedUntil : undefined,
          });
        }
      }
    }
  }

  record(languageId: string, context: TriggerContext, accepted: boolean): boolean {
    const key = `${languageId}:${context}`;
    const state = this.states.get(key) ?? { outcomes: '' };
    state.outcomes = (state.outcomes + (accepted ? '1' : '0')).slice(-WINDOW);
    let muted = false;
    if (state.outcomes.length === WINDOW) {
      const acceptedCount = state.outcomes.split('1').length - 1;
      if (acceptedCount / WINDOW < MIN_ACCEPTANCE) {
        state.mutedUntil = this.now() + MUTE_MS;
        state.outcomes = '';
        muted = true;
      }
    }
    this.states.set(key, state);
    this.save();
    return muted;
  }

  isSuppressed(languageId: string, context: TriggerContext): boolean {
    const state = this.states.get(`${languageId}:${context}`);
    if (!state?.mutedUntil) return false;
    if (state.mutedUntil > this.now()) return true;
    state.mutedUntil = undefined;
    this.save();
    return false;
  }

  report(): ContextReport[] {
    const now = this.now();
    return [...this.states.entries()].map(([key, state]) => {
      const separator = key.lastIndexOf(':');
      return {
        languageId: key.slice(0, separator),
        context: key.slice(separator + 1) as TriggerContext,
        shown: state.outcomes.length,
        accepted: state.outcomes.split('1').length - 1,
        mutedUntil: state.mutedUntil && state.mutedUntil > now ? state.mutedUntil : undefined,
      };
    });
  }

  clear(): void {
    this.states.clear();
    void this.store.update(STORE_KEY, undefined);
  }

  private save(): void {
    void this.store.update(STORE_KEY, Object.fromEntries(this.states));
  }
}
