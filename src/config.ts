import * as vscode from 'vscode';
import type { WorkerMode } from './cli/workerPool';
import { DEFAULT_EXCLUDE_PATTERNS } from './context/exclusions';

export type TriggerMode = 'auto' | 'manual';
export type PromptCacheMode = 'auto' | 'on' | 'off';
export type ReasoningMode = 'minimal' | 'adaptive';

export interface GhostlineConfig {
  enabled: boolean;
  cliPath: string;
  model: string;
  effort: string;
  triggerMode: TriggerMode;
  debounceMs: number;
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

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function positive(value: unknown, fallback: number, min = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
}

function strings(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [...fallback];
}

export function readConfig(): GhostlineConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    enabled: cfg.get<boolean>('enabled', true),
    cliPath: cfg.get<string>('cliPath', '') ?? '',
    model: (cfg.get<string>('model', 'haiku') ?? '').trim() || 'haiku',
    effort: oneOf(cfg.get('effort'), ['low', 'medium', 'high', 'xhigh', 'max'] as const, 'low'),
    triggerMode: oneOf(cfg.get('triggerMode'), ['auto', 'manual'] as const, 'auto'),
    debounceMs: positive(cfg.get('debounceMs'), 350),
    maxLines: Math.floor(positive(cfg.get('maxLines'), 6, 1)),
    requestTimeoutMs: positive(cfg.get('requestTimeoutMs'), 8000, 1000),
    dailyRequestLimit: Math.floor(positive(cfg.get('dailyRequestLimit'), 1500)),
    disabledLanguages: strings(cfg.get('disabledLanguages'), ['markdown', 'plaintext']),
    excludePatterns: strings(cfg.get('excludePatterns'), DEFAULT_EXCLUDE_PATTERNS),
    workerMode: oneOf(cfg.get('workerMode'), ['single-use', 'persistent'] as const, 'single-use'),
    recycleEvery: Math.floor(positive(cfg.get('recycleEvery'), 8, 1)),
    promptCache: oneOf(cfg.get('promptCache'), ['auto', 'on', 'off'] as const, 'auto'),
    reasoning: oneOf(cfg.get('reasoning'), ['minimal', 'adaptive'] as const, 'minimal'),
    prefixLines: Math.floor(positive(cfg.get('context.prefixLines'), 60, 1)),
    suffixLines: Math.floor(positive(cfg.get('context.suffixLines'), 20)),
    symbolContext: cfg.get<boolean>('context.symbols', false),
    learningExamples: cfg.get<boolean>('learning.examples', true),
    adaptiveTrigger: cfg.get<boolean>('learning.adaptiveTrigger', true),
    logPrompts: cfg.get<boolean>('debug.logPrompts', false),
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
