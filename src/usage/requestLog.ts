import type { Usage } from '../cli/streamParser';

export interface RequestLogEntry {
  id: number;
  time: Date;
  languageId: string;
  /** Where the cursor was: after-dot, after-paren, new-line or end-of-line. */
  context: string;
  manual: boolean;
  waitForWorkerMs: number;
  firstTokenMs: number | null;
  totalMs: number;
  usage: Usage;
  /** Usage comes from `message_start` because the request was cut short. */
  usagePartial: boolean;
}

function clock(time: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}

function ms(value: number | null): string {
  return value === null ? '–' : `${Math.round(value)} ms`;
}

/**
 * One line per request for the "ghostline" output channel: how long it waited for a process, time
 * to first token, total time, tokens, and what became of the suggestion.
 */
export function formatRequestLine(entry: RequestLogEntry, outcome: string): string {
  const { usage } = entry;
  return [
    `[${clock(entry.time)}] #${entry.id} ${entry.languageId} ${entry.context}${entry.manual ? ' (manual)' : ''}`,
    `espera ${ms(entry.waitForWorkerMs)}`,
    `primer token ${ms(entry.firstTokenMs)}`,
    `total ${ms(entry.totalMs)}`,
    `tokens${entry.usagePartial ? ' (parcial)' : ''}: entrada ${usage.inputTokens}, salida ${usage.outputTokens}, ` +
      `razonamiento ${usage.thinkingTokens}, caché ${usage.cacheReadTokens}/${usage.cacheWriteTokens}`,
    outcome,
  ].join(' · ');
}
