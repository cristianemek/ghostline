import type { RateLimitInfo } from '../cli/streamParser';
import { acceptanceRate, formatTokens, totalTokens, type DayStats } from './usageTracker';

export interface LatencyStats {
  p50?: number;
  p95?: number;
}

export interface SessionInfo {
  triggerMode: string;
  workerMode: string;
  paused: boolean;
  limitReached: boolean;
  dailyLimit: number;
  /** Resolved model reported by the CLI, or the configured alias before the first request. */
  model: string;
  /** `apiKeySource` from system/init; undefined until the first request. */
  apiKeySource?: string;
  cliError?: string;
  rateLimit?: RateLimitInfo;
  learning?: {
    /** Accepted completions stored for this workspace. */
    examples: number;
    hasProfile: boolean;
    /** Language/context pairs muted by the adaptive trigger, already formatted. */
    muted: string[];
  };
}

function percent(rate: number | undefined): string {
  return rate === undefined ? '–' : `${Math.round(rate * 100)}%`;
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

/** `ghostline 123 · 180k tok · 34% ✓` */
export function statusText(day: DayStats, session: SessionInfo): string {
  if (session.cliError) return '$(warning) ghostline: sin CLI';
  const counters = `${day.requests} · ${formatTokens(totalTokens(day))} tok · ${percent(acceptanceRate(day))} ✓`;
  if (session.paused) return `$(debug-pause) ghostline ${counters}`;
  if (session.limitReached) return `$(circle-slash) ghostline ${counters}`;
  if (session.triggerMode === 'manual') return `ghostline (manual) ${counters}`;
  return `ghostline ${counters}`;
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5 h',
  seven_day: '7 días',
  seven_day_opus: '7 días (Opus)',
  seven_day_sonnet: '7 días (Sonnet)',
};

function rateLimitLine(info: RateLimitInfo): string | undefined {
  const parts = Object.entries(info.windows).map(
    ([name, window]) => `${WINDOW_LABELS[name] ?? name} ${Math.round(window.utilization * 100)}%`,
  );
  return parts.length > 0 ? `Límites de la suscripción: ${parts.join(' · ')}` : undefined;
}

/** Tooltip of the status bar item, one markdown line per entry. */
export function tooltipLines(day: DayStats, latency: LatencyStats, medianInput: number | undefined, session: SessionInfo): string[] {
  const lines: string[] = [];
  const state = session.paused ? 'en pausa' : session.triggerMode === 'manual' ? 'modo manual' : 'modo auto';
  lines.push(`**ghostline** — ${state} · procesos ${session.workerMode}`);
  if (session.cliError) lines.push(`$(warning) ${session.cliError}`);
  if (usesApiKey(session.apiKeySource)) {
    lines.push(`$(warning) La CLI usa una API key (\`${session.apiKeySource}\`): se factura la API, no la suscripción.`);
  }
  if (session.limitReached) {
    lines.push(`$(circle-slash) Límite diario alcanzado (${session.dailyLimit}): el modo auto está en pausa, el manual sigue funcionando.`);
  }
  lines.push(
    `Hoy: ${day.requests} peticiones` +
      (session.dailyLimit > 0 ? ` de ${session.dailyLimit}` : '') +
      ` · ${day.cancelled} canceladas · ${day.errors + day.timeouts} fallidas · ${day.localHits} servidas en local`,
  );
  lines.push(
    `Tokens: entrada ${formatTokens(day.inputTokens)} · salida ${formatTokens(day.outputTokens)} · ` +
      `razonamiento ${formatTokens(day.thinkingTokens)} · caché ${formatTokens(day.cacheReadTokens)} leídos / ` +
      `${formatTokens(day.cacheWriteTokens)} escritos`,
  );
  lines.push(`Entrada por petición (mediana): ${medianInput === undefined ? '–' : formatTokens(medianInput)} tokens`);
  lines.push(`Sugerencias: ${day.shown} mostradas · ${day.accepted} aceptadas (${percent(acceptanceRate(day))})`);
  lines.push(`Latencia: p50 ${ms(latency.p50)} · p95 ${ms(latency.p95)}`);
  lines.push(
    `Modelo: ${session.model} · apiKeySource: ${session.apiKeySource ?? 'aún sin datos'}` +
      (session.apiKeySource === 'none' ? ' (suscripción)' : ''),
  );
  if (session.rateLimit) {
    const line = rateLimitLine(session.rateLimit);
    if (line) lines.push(line);
  }
  if (session.learning) {
    const { examples, hasProfile, muted } = session.learning;
    lines.push(
      `Aprendizaje: ${examples} ejemplos aceptados · perfil de estilo: ${hasProfile ? 'sí' : 'no'}` +
        (muted.length > 0 ? ` · silenciado 24 h: ${muted.join(', ')}` : ''),
    );
  }
  if (day.costUsd > 0) lines.push(`Coste equivalente en la API: ${usd(day.costUsd)}`);
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
