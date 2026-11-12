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
 * what a session is worth (`ghostline.claudeSessionUsd`), both on the high side.
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

/** ghostline's own glyph: the ghost over its line, from the icon font declared in package.json ("icons"). */
export const MARK = '$(ghostline-ghost)';

/**
 * The ghost, then `8% · Claude 0,03%`: how much of ghostline's own daily cap is used, and how much
 * of a whole Claude session ghostline has taken. When there is something to say about its state, a
 * second icon says it. Tokens, latency and cost are one click away, in the last-7-days list and
 * the log.
 */
export function statusText(day: DayStats, session: SessionInfo): string {
  if (session.cliError) return `${MARK} $(warning) sin CLI`;
  const counters = `${dailyShare(day, session.dailyLimit)} · Claude ${sessionShare(session)}`;
  if (session.paused) return `${MARK} $(debug-pause) ${counters}`;
  if (session.trouble) return `${MARK} $(warning) ${counters}`;
  if (session.limitReached) return `${MARK} $(circle-slash) ${counters}`;
  if (session.triggerMode === 'manual') return `${MARK} manual · ${counters}`;
  return `${MARK} ${counters}`;
}

/** The status bar's text in words only, for where icons are not drawn (a prompt, a screen reader). */
export function plainStatus(text: string): string {
  return text.replace(MARK, 'ghostline').replace(/\$\([\w-]+\)\s*/g, '').trim();
}

/** The commands the tooltip's links may run; nothing else in it is clickable. */
export const TOOLTIP_COMMANDS: readonly string[] = [
  'ghostline.togglePause',
  'ghostline.toggleTriggerMode',
  'ghostline.showUsage',
  'ghostline.showRecent',
  'ghostline.openSettings',
];

/** Text that did not come from ghostline (a path, what the CLI said), safe inside the tooltip's markdown and HTML. */
function plain(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]()#|$~]/g, '\\$&');
}

const BAR_CELLS = 28;
/** Half a block: side by side they make a bar, in any font that has box-drawing characters. */
export const BAR_CELL = '▄';
/** The editor only lets a tooltip set colours, and only from the theme: these are its variables. */
const TRACK = '--vscode-disabledForeground';
const tint = (variable: string, text: string): string => `<span style="color:var(${variable});">${text}</span>`;
const small = (text: string): string => tint('--vscode-descriptionForeground', text);

/** A meter drawn with text: each part takes its share of the cells; something used never takes none. */
function meter(parts: readonly { rate: number; colour: string }[]): string {
  let used = 0;
  let drawn = '';
  for (const part of parts) {
    const rate = Math.min(1, Math.max(0, part.rate));
    const cells = Math.min(BAR_CELLS - used, rate > 0 ? Math.max(1, Math.round(rate * BAR_CELLS)) : 0);
    if (cells > 0) drawn += tint(part.colour, BAR_CELL.repeat(cells));
    used += cells;
  }
  return drawn + (used < BAR_CELLS ? tint(TRACK, BAR_CELL.repeat(BAR_CELLS - used)) : '');
}

/**
 * One figure of the tooltip: how much, in large type, and of what; the meter; and the numbers
 * behind it. A tooltip cannot choose a size for its text, only a heading level.
 */
function figure(value: string, of: string, bar: string, detail: string): string {
  return `### ${value} &nbsp;${small(`· ${of}`)}\n\n${bar}  \n${small(detail)}`;
}

/**
 * The status bar item's tooltip, as markdown with a little HTML: the name and the state on top,
 * then whatever needs attention, the three figures each with its meter, and the things one would
 * otherwise open the menu for.
 */
export function tooltipMarkdown(day: DayStats, session: SessionInfo): string {
  const state = session.paused ? 'en pausa' : session.triggerMode === 'manual' ? 'modo manual' : 'modo auto';
  const blocks: string[] = [`## ${MARK}&nbsp; ghostline`, small(`Autocompletado con Claude · ${state}`)];

  const warnings: string[] = [];
  if (session.cliError) warnings.push(`$(warning) ${plain(session.cliError)}`);
  if (usesApiKey(session.apiKeySource)) {
    warnings.push(`$(warning) La CLI usa una API key (${plain(session.apiKeySource ?? '')}): se factura la API, no la suscripción.`);
  }
  if (session.trouble) {
    warnings.push(
      `$(warning) Sugerencias automáticas en pausa ${Math.ceil(session.trouble.remainingMs / 1000)} s por errores repetidos de la CLI: ` +
        `${plain(session.trouble.reason.slice(0, 160))}. La invocación manual sigue disponible.`,
    );
  }
  if (session.limitReached) {
    warnings.push(`$(circle-slash) Límite diario alcanzado (${session.dailyLimit}): el modo auto está en pausa, el manual sigue funcionando.`);
  }
  if (warnings.length > 0) blocks.push(warnings.map((line) => tint('--vscode-editorWarning-foreground', line)).join('  \n'));

  blocks.push('---');
  blocks.push(
    session.dailyLimit > 0
      ? figure(
          dailyShare(day, session.dailyLimit),
          'de tu tope diario',
          meter([{ rate: day.requests / session.dailyLimit, colour: '--vscode-charts-purple' }]),
          `${day.requests} de ${session.dailyLimit} peticiones hoy`,
        )
      : figure(String(day.requests), 'peticiones hoy', meter([]), 'sin tope diario'),
  );
  // ghostline's own part of the session and, when the CLI has said it, how full the session is.
  const whole = session.rateLimit?.windows.five_hour?.utilization;
  const own = session.sessionBudgetUsd > 0 ? session.sessionSpentUsd / session.sessionBudgetUsd : 0;
  const ownShare = sessionShare(session);
  blocks.push(
    figure(
      /^\d/.test(ownShare) && own > 0 ? `≈${ownShare}` : ownShare,
      'de la sesión de Claude (5 h)',
      meter([
        { rate: own, colour: '--vscode-charts-purple' },
        { rate: whole === undefined ? 0 : Math.max(0, whole - own), colour: '--vscode-charts-blue' },
      ]),
      `ghostline: ${usd(session.sessionSpentUsd)} de unos ${Math.round(session.sessionBudgetUsd)} $` +
        (whole === undefined ? '' : ` · la sesión entera va por el ${share(whole)}`),
    ),
  );
  blocks.push(
    figure(
      percent(acceptanceRate(day)),
      'aceptadas',
      meter([{ rate: acceptanceRate(day) ?? 0, colour: '--vscode-charts-green' }]),
      `${day.accepted} de ${day.shown} sugerencias`,
    ),
  );
  if (session.muted && session.muted.length > 0) blocks.push(small(`Silenciado 24 h: ${session.muted.map(plain).join(', ')}`));

  blocks.push('---');
  blocks.push(
    [
      `[$(${session.paused ? 'debug-start' : 'debug-pause'}) ${session.paused ? 'Reanudar' : 'Pausar'}](command:ghostline.togglePause)`,
      `[$(${session.triggerMode === 'manual' ? 'zap' : 'person'}) ${session.triggerMode === 'manual' ? 'Modo auto' : 'Modo manual'}](command:ghostline.toggleTriggerMode)`,
      '[$(graph) Consumo](command:ghostline.showUsage)',
      '[$(history) Últimas](command:ghostline.showRecent)',
      '[$(gear) Ajustes](command:ghostline.openSettings)',
    ].join(' &nbsp;·&nbsp; '),
  );
  return blocks.join('\n\n');
}

/** Above this median latency the user is told and offered adjustments. */
export const SLOW_P50_MS = 1500;

/**
 * Periodic line for the log with the day's latency percentiles and input size. `warnSlow`: whether a
 * slow median deserves a warning (not when the model is left to think, which is slow by choice).
 */
export function summaryLine(day: DayStats, latency: LatencyStats, medianInput: number | undefined, warnSlow = true): string {
  const parts = [
    `resumen de hoy: ${day.requests} peticiones`,
    `latencia p50 ${ms(latency.p50)} / p95 ${ms(latency.p95)}`,
    `entrada mediana ${medianInput === undefined ? '–' : Math.round(medianInput)} tokens`,
    `${day.shown} mostradas, ${day.accepted} aceptadas (${percent(acceptanceRate(day))})`,
  ];
  if (warnSlow && latency.p50 !== undefined && latency.p50 > SLOW_P50_MS) {
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
