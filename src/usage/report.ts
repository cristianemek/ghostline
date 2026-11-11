import type { RateLimitInfo } from '../cli/streamParser';
import { acceptanceRate, formatTokens, totalTokens, type DayStats } from './usageTracker';

export interface LatencyStats {
  p50?: number;
  p95?: number;
}

export interface SessionInfo {
  triggerMode: string;
  paused: boolean;
  limitReached: boolean;
  dailyLimit: number;
  /** `apiKeySource` from system/init; undefined until the first request. */
  apiKeySource?: string;
  cliError?: string;
  rateLimit?: RateLimitInfo;
  /** Automatic requests are paused after repeated failures. */
  trouble?: { remainingMs: number; reason: string };
  /** Language/context pairs muted by the adaptive trigger, already formatted. */
  muted?: string[];
}

function percent(rate: number | undefined): string {
  return rate === undefined ? '–' : `${Math.round(rate * 100)}%`;
}

/** A share of a limit: something used never reads as 0%. */
function share(rate: number): string {
  if (rate > 0 && rate < 0.01) return '<1%';
  return `${Math.round(rate * 100)}%`;
}

/** Today's requests against ghostline's own daily cap; the bare count when there is no cap. */
function dailyShare(day: DayStats, dailyLimit: number): string {
  return dailyLimit > 0 ? share(day.requests / dailyLimit) : String(day.requests);
}

/** How full Claude's current session (the subscription's 5-hour window) is, as the CLI last reported it. */
function sessionShare(rateLimit: RateLimitInfo | undefined): string {
  const window = rateLimit?.windows.five_hour;
  return window ? share(window.utilization) : '–';
}

function ms(value: number | undefined): string {
  return value === undefined ? '–' : `${Math.round(value)} ms`;
}

function usd(value: number): string {
  return `${value.toFixed(value < 1 ? 4 : 2).replace('.', ',')} $`;
}

/** True when the CLI is authenticating with something other than the subscription. */
export function usesApiKey(apiKeySource: string | undefined): boolean {
  return apiKeySource !== undefined && apiKeySource !== '' && apiKeySource !== 'none';
}

/**
 * `ghostline 8% · Claude 59%`: how much of ghostline's own daily cap is used, and how full Claude's
 * session is. (The spec asked for requests · tokens · acceptance; in use, these two were the ones
 * worth a glance. The rest is one click away, in the last-7-days list and the log.)
 */
export function statusText(day: DayStats, session: SessionInfo): string {
  if (session.cliError) return '$(warning) ghostline: sin CLI';
  const counters = `${dailyShare(day, session.dailyLimit)} · Claude ${sessionShare(session.rateLimit)}`;
  if (session.paused) return `$(debug-pause) ghostline ${counters}`;
  if (session.trouble) return `$(warning) ghostline ${counters}`;
  if (session.limitReached) return `$(circle-slash) ghostline ${counters}`;
  if (session.triggerMode === 'manual') return `ghostline (manual) ${counters}`;
  return `ghostline ${counters}`;
}

/**
 * Tooltip of the status bar item, one markdown line per entry: what the two figures mean, how the
 * suggestions are doing, and whatever needs attention. Nothing else.
 */
export function tooltipLines(day: DayStats, session: SessionInfo): string[] {
  const lines: string[] = [];
  const state = session.paused ? 'en pausa' : session.triggerMode === 'manual' ? 'modo manual' : 'modo auto';
  lines.push(`**ghostline** — ${state}`);
  if (session.cliError) lines.push(`$(warning) ${session.cliError}`);
  if (usesApiKey(session.apiKeySource)) {
    lines.push(`$(warning) La CLI usa una API key (\`${session.apiKeySource}\`): se factura la API, no la suscripción.`);
  }
  if (session.trouble) {
    lines.push(
      `$(warning) Sugerencias automáticas en pausa ${Math.ceil(session.trouble.remainingMs / 1000)} s por errores repetidos de la CLI: ` +
        `${session.trouble.reason.slice(0, 160)}. La invocación manual sigue disponible.`,
    );
  }
  if (session.limitReached) {
    lines.push(`$(circle-slash) Límite diario alcanzado (${session.dailyLimit}): el modo auto está en pausa, el manual sigue funcionando.`);
  }
  lines.push(
    session.dailyLimit > 0
      ? `Tu tope diario: ${dailyShare(day, session.dailyLimit)} (${day.requests} de ${session.dailyLimit} peticiones)`
      : `Hoy: ${day.requests} peticiones (sin tope diario)`,
  );
  const week = session.rateLimit?.windows.seven_day;
  lines.push(
    session.rateLimit?.windows.five_hour
      ? `Sesión de Claude (5 h): ${sessionShare(session.rateLimit)}` + (week ? ` · semana: ${share(week.utilization)}` : '')
      : 'Sesión de Claude: sin datos hasta la primera petición',
  );
  lines.push(`Aceptadas: ${day.accepted} de ${day.shown} (${percent(acceptanceRate(day))})`);
  if (session.muted && session.muted.length > 0) lines.push(`Silenciado 24 h: ${session.muted.join(', ')}`);
  return lines;
}

/** The spec's threshold: above this median latency the user is told and offered adjustments. */
export const SLOW_P50_MS = 1500;

/** Periodic line for the log with the day's latency percentiles and input size. */
export function summaryLine(day: DayStats, latency: LatencyStats, medianInput: number | undefined): string {
  const parts = [
    `resumen de hoy: ${day.requests} peticiones`,
    `latencia p50 ${ms(latency.p50)} / p95 ${ms(latency.p95)}`,
    `entrada mediana ${medianInput === undefined ? '–' : Math.round(medianInput)} tokens`,
    `${day.shown} mostradas, ${day.accepted} aceptadas (${percent(acceptanceRate(day))})`,
  ];
  if (latency.p50 !== undefined && latency.p50 > SLOW_P50_MS) {
    parts.push(
      'AVISO: la p50 supera 1,5 s; prueba el modo manual ("ghostline.triggerMode") ' +
        'o reduce el contexto ("ghostline.context.prefixLines")',
    );
  }
  return `— ${parts.join(' · ')}`;
}

/** One row of the "last 7 days" list. */
export function dayRow(day: DayStats, latency: LatencyStats, medianInput: number | undefined): { summary: string; detail: string } {
  return {
    summary: `${day.requests} peticiones · ${formatTokens(totalTokens(day))} tok · ${percent(acceptanceRate(day))} ✓`,
    detail:
      `entrada ${formatTokens(day.inputTokens)} · salida ${formatTokens(day.outputTokens)} · ` +
      `mediana ${medianInput === undefined ? '–' : formatTokens(medianInput)}/petición · ` +
      `p50 ${ms(latency.p50)} · p95 ${ms(latency.p95)} · ${day.shown} mostradas, ${day.accepted} aceptadas` +
      (day.costUsd > 0 ? ` · ${usd(day.costUsd)} equiv.` : ''),
  };
}
