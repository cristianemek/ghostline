import * as vscode from 'vscode';
import type { WorkerMode } from './cli/workerPool';
import { DEFAULT_EXCLUDE_PATTERNS } from './context/exclusions';

export type TriggerMode = 'auto' | 'manual';
export type PromptCacheMode = 'auto' | 'on' | 'off';
export type ReasoningMode = 'minimal' | 'adaptive';
/**
 * How much ghostline bets on a suggestion being wanted before the user has clearly paused.
 * off: never; a request is only sent after a full pause. line: one bet per new line (short wait on
 * an empty line) and no wait right after accepting. A third level that also bet inside the line was
 * measured and dropped: more tokens, no gain. Either way a request that is already in the air is
 * kept while the typing agrees with its answer: it has been paid for.
 */
export type Speculation = 'off' | 'line';

export interface GhostlineConfig {
  enabled: boolean;
  cliPath: string;
  model: string;
  effort: string;
  triggerMode: TriggerMode;
  debounceMs: number;
  /** Shorter wait used at trigger points (new line, after ".", "(", "="…). */
  eagerDebounceMs: number;
  speculation: Speculation;
  /** Auto mode also asks right after typing in the middle of a line, with code after the cursor. */
  midLine: boolean;
  maxLines: number;
  requestTimeoutMs: number;
  dailyRequestLimit: number;
  disabledLanguages: string[];
  excludePatterns: string[];
  workerMode: WorkerMode;
  recycleEvery: number;
  promptCache: PromptCacheMode;
  reasoning: ReasoningMode;
  prefixLines: number;
  suffixLines: number;
  symbolContext: boolean;
  learningExamples: boolean;
  adaptiveTrigger: boolean;
  logPrompts: boolean;
}

const SECTION = 'ghostline';
/** A model alias or id. Anything else (in particular something starting with "-") is not passed to the CLI. */
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function number(value: unknown, fallback: number, min = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
}

function strings(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [...fallback];
}

/**
 * Security rule for settings: a workspace (a `.vscode/settings.json` that came with a repository) may
 * only make ghostline more conservative, never make it send or spend more than the user configured.
 *
 * - Settings that decide what is executed, sent or spent are read from the user's settings only.
 * - The few that make sense per project are combined so that the stricter value wins.
 */
class Settings {
  constructor(private readonly cfg: vscode.WorkspaceConfiguration) {}

  /** The user's own value (or the default); workspace values are ignored. */
  user(name: string): unknown {
    const inspected = this.cfg.inspect<unknown>(name);
    return inspected?.globalValue ?? inspected?.defaultValue;
  }

  /** Values a workspace or workspace folder set, if any. */
  workspace(name: string): unknown[] {
    const inspected = this.cfg.inspect<unknown>(name);
    return [inspected?.workspaceValue, inspected?.workspaceFolderValue].filter((value) => value !== undefined);
  }
}

export function readConfig(): GhostlineConfig {
  const settings = new Settings(vscode.workspace.getConfiguration(SECTION));
  const user = (name: string): unknown => settings.user(name);
  const workspace = (name: string): unknown[] => settings.workspace(name);

  const model = String(user('model') ?? '').trim();
  const debounceMs = number(user('debounceMs'), 600);
  const eagerDebounceMs = number(user('eagerDebounceMs'), 120);
  const maxLines = Math.floor(number(user('maxLines'), 6, 1));
  const prefixLines = Math.floor(number(user('context.prefixLines'), 60, 1));
  const suffixLines = Math.floor(number(user('context.suffixLines'), 20));

  return {
    // A workspace can switch ghostline off for itself, not back on.
    enabled: user('enabled') !== false && workspace('enabled').every((value) => value !== false),
    cliPath: String(user('cliPath') ?? ''),
    model: SAFE_MODEL.test(model) ? model : 'haiku',
    effort: oneOf(user('effort'), ['low', 'medium', 'high', 'xhigh', 'max'] as const, 'low'),
    // …and can ask for manual mode, not force automatic requests.
    triggerMode:
      oneOf(user('triggerMode'), ['auto', 'manual'] as const, 'auto') === 'manual' || workspace('triggerMode').includes('manual')
        ? 'manual'
        : 'auto',
    debounceMs: Math.max(debounceMs, ...workspace('debounceMs').map((value) => number(value, debounceMs))),
    eagerDebounceMs: Math.max(eagerDebounceMs, ...workspace('eagerDebounceMs').map((value) => number(value, eagerDebounceMs))),
    maxLines: Math.min(maxLines, ...workspace('maxLines').map((value) => Math.floor(number(value, maxLines, 1)))),
    requestTimeoutMs: number(user('requestTimeoutMs'), 8000, 1000),
    dailyRequestLimit: Math.floor(number(user('dailyRequestLimit'), 1500)),
    disabledLanguages: [
      ...new Set([
        ...strings(user('disabledLanguages'), ['markdown', 'plaintext']),
        ...workspace('disabledLanguages').flatMap((value) => strings(value, [])),
      ]),
    ],
    // Exclusions add up: a workspace can protect more files, never fewer.
    excludePatterns: [
      ...new Set([
        ...strings(user('excludePatterns'), DEFAULT_EXCLUDE_PATTERNS),
        ...workspace('excludePatterns').flatMap((value) => strings(value, [])),
      ]),
    ],
    workerMode: oneOf(user('workerMode'), ['single-use', 'persistent'] as const, 'single-use'),
    recycleEvery: Math.floor(number(user('recycleEvery'), 8, 1)),
    promptCache: oneOf(user('promptCache'), ['auto', 'on', 'off'] as const, 'auto'),
    reasoning: oneOf(user('reasoning'), ['minimal', 'adaptive'] as const, 'adaptive'),
    speculation: oneOf(user('speculation'), ['off', 'line'] as const, 'off'),
    // More requests, so the user's call; a workspace can only switch it off.
    midLine: user('midLine') !== false && workspace('midLine').every((value) => value !== false),
    prefixLines: Math.min(prefixLines, ...workspace('context.prefixLines').map((value) => Math.floor(number(value, prefixLines, 1)))),
    suffixLines: Math.min(suffixLines, ...workspace('context.suffixLines').map((value) => Math.floor(number(value, suffixLines)))),
    // On unless the user switches it off; a workspace can switch it off, never on.
    symbolContext: user('context.symbols') !== false && workspace('context.symbols').every((value) => value !== false),
    learningExamples: user('learning.examples') !== false,
    adaptiveTrigger: user('learning.adaptiveTrigger') !== false,
    logPrompts: user('debug.logPrompts') === true,
  };
}

/** Settings baked into the CLI processes: changing one means relaunching them. */
const POOL_SETTINGS = ['cliPath', 'model', 'effort', 'workerMode', 'recycleEvery', 'promptCache', 'reasoning'];

export function affectsPool(event: vscode.ConfigurationChangeEvent): boolean {
  return POOL_SETTINGS.some((name) => event.affectsConfiguration(`${SECTION}.${name}`));
}

export function affectsGhostline(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(SECTION);
}

/** Whether the API prompt cache stays on for the CLI processes (see docs/paso-0.md, finding 4). */
export function promptCacheEnabled(config: GhostlineConfig): boolean {
  if (config.promptCache === 'on') return true;
  if (config.promptCache === 'off') return false;
  return config.workerMode === 'persistent';
}

export async function setTriggerMode(mode: TriggerMode): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update('triggerMode', mode, vscode.ConfigurationTarget.Global);
}

export async function updateSetting(name: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(name, value, vscode.ConfigurationTarget.Global);
}
