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
  /** What ghostline has spent since the current Claude session began, in API-equivalent dollars. */
  sessionSpentUsd: number;
  /** What a whole Claude session is worth in the same dollars (`ghostline.claudeSessionUsd`). */
  sessionBudgetUsd: number;
}

const FIVE_HOURS_MS = 5 * 3600_000;

/**
 * When the Claude session ghostline's spend is measured against began. The CLI says when the
 * session it last saw ends; it lasts five hours. Once that one is over, what was spent after it
 * belongs to the next. With nothing reported yet, the last five hours stand in for it.
 */
export function sessionStart(rateLimit: RateLimitInfo | undefined, nowMs: number): number {
  const resetsAt = (rateLimit?.windows.five_hour?.resetsAt ?? 0) * 1000;
  if (resetsAt > nowMs) return resetsAt - FIVE_HOURS_MS;
  return Math.max(resetsAt, nowMs - FIVE_HOURS_MS);
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

/**
 * A share that is usually a small fraction of one percent, with enough digits to tell 0,03% from
 * 0,3%: two decimals under 1%, one under 10%.
 */
function fineShare(rate: number): string {
  const value = rate * 100;
  if (!(value > 0)) return '0%';
  if (value < 0.01) return '<0,01%';
  const digits = value < 1 ? 2 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits).replace('.', ',')}%`;
}

/**
 * The part of a whole Claude session (the subscription's 5-hour window) that ghostline itself has
 * used. An estimate: Anthropic publishes no formula, so it is ghostline's spend at API prices over
 * what a session was measured to be worth (see docs/consumo.md), both on the high side.
 */
function sessionShare(session: SessionInfo): string {
  return session.sessionBudgetUsd > 0 ? fineShare(session.sessionSpentUsd / session.sessionBudgetUsd) : '–';
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
 * `ghostline 8% · Claude 0,03%`: how much of ghostline's own daily cap is used, and how much of a
 * whole Claude session ghostline has taken. (The spec asked for requests · tokens · acceptance; in
 * use, these two were the ones worth a glance. The rest is one click away, in the last-7-days list
 * and the log.)
 */
export function statusText(day: DayStats, session: SessionInfo): string {
  if (session.cliError) return '$(warning) ghostline: sin CLI';
  const counters = `${dailyShare(day, session.dailyLimit)} · Claude ${sessionShare(session)}`;
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
  const whole = session.rateLimit?.windows.five_hour;
  lines.push(
    `De la sesión de Claude (5 h), ghostline: ≈${sessionShare(session)} ` +
      `(${usd(session.sessionSpentUsd)} de unos ${Math.round(session.sessionBudgetUsd)} $)` +
      (whole ? ` · la sesión entera va por el ${share(whole.utilization)}` : ''),
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
