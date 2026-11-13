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
  apiKeySource?: string;
  cliError?: string;
  rateLimit?: RateLimitInfo;
  trouble?: { remainingMs: number; reason: string };
  muted?: string[];
  sessionSpentUsd: number;
  sessionBudgetUsd: number;
}

const FIVE_HOURS_MS = 5 * 3600_000;

export function sessionStart(rateLimit: RateLimitInfo | undefined, nowMs: number): number {
  const resetsAt = (rateLimit?.windows.five_hour?.resetsAt ?? 0) * 1000;
  if (resetsAt > nowMs) return resetsAt - FIVE_HOURS_MS;
  return Math.max(resetsAt, nowMs - FIVE_HOURS_MS);
}

function percent(rate: number | undefined): string {
  return rate === undefined ? '–' : `${Math.round(rate * 100)}%`;
}

function share(rate: number): string {
  if (rate > 0 && rate < 0.01) return '<1%';
  return `${Math.round(rate * 100)}%`;
}

function dailyShare(day: DayStats, dailyLimit: number): string {
  return dailyLimit > 0 ? share(day.requests / dailyLimit) : String(day.requests);
}

function fineShare(rate: number): string {
  const value = rate * 100;
  if (!(value > 0)) return '0%';
  if (value < 0.01) return '<0,01%';
  const digits = value < 1 ? 2 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits).replace('.', ',')}%`;
}

function sessionShare(session: SessionInfo): string {
  return session.sessionBudgetUsd > 0 ? fineShare(session.sessionSpentUsd / session.sessionBudgetUsd) : '–';
}

function ms(value: number | undefined): string {
  return value === undefined ? '–' : `${Math.round(value)} ms`;
}

function usd(value: number): string {
  return `${value.toFixed(value < 1 ? 4 : 2).replace('.', ',')} $`;
}

export function usesApiKey(apiKeySource: string | undefined): boolean {
  return apiKeySource !== undefined && apiKeySource !== '' && apiKeySource !== 'none';
}

export const MARK = '$(ghostline-ghost)';

export function statusText(day: DayStats, session: SessionInfo): string {
  if (session.cliError) return `${MARK} $(warning) sin CLI`;
  const second = usesApiKey(session.apiKeySource) ? money(day.costUsd) : `Claude ${sessionShare(session)}`;
  const counters = `${dailyShare(day, session.dailyLimit)} · ${second}`;
  if (session.paused) return `${MARK} $(debug-pause) ${counters}`;
  if (session.trouble) return `${MARK} $(warning) ${counters}`;
  if (session.limitReached) return `${MARK} $(circle-slash) ${counters}`;
  if (session.triggerMode === 'manual') return `${MARK} manual · ${counters}`;
  return `${MARK} ${counters}`;
}

export function plainStatus(text: string): string {
  return text.replace(MARK, 'ghostline').replace(/\$\([\w-]+\)\s*/g, '').trim();
}

export const TOOLTIP_COMMANDS: readonly string[] = [
  'ghostline.togglePause',
  'ghostline.toggleTriggerMode',
  'ghostline.showUsage',
  'ghostline.showRecent',
  'ghostline.openSettings',
];

function plain(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]()#|$~]/g, '\\$&');
}

function money(value: number): string {
  if (!(value > 0)) return '0 $';
  if (value < 0.01) return '<0,01 $';
  return `${value.toFixed(2).replace('.', ',')} $`;
}

const HUE = { violet: '#A78BFA', teal: '#2DD4BF', blue: '#60A5FA', green: '#4ADE80', yellow: '#FACC15', slate: '#94A3B8', night: '#1E293B' } as const;

const tint = (variable: string, text: string): string => `<span style="color:var(${variable});">${text}</span>`;
const small = (text: string): string => tint('--vscode-descriptionForeground', text);

const svg = (width: number, height: number, viewBox: string, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}">${body}</svg>`;

function picture(drawing: string, alt: string): string {
  return `![${alt}](data:image/svg+xml;base64,${Buffer.from(drawing, 'utf8').toString('base64')})`;
}

export const METER_WIDTH = 300;
const METER_HEIGHT = 8;

export function meterStops(parts: readonly { rate: number }[], width: number = METER_WIDTH): number[] {
  let end = 0;
  return parts.map((part) => {
    const rate = Math.min(1, Math.max(0, part.rate));
    end = Math.min(width, end + (rate > 0 ? Math.max(METER_HEIGHT, Math.round(rate * width)) : 0));
    return end;
  });
}

function meter(parts: readonly { rate: number; colour: string; opacity?: number }[]): string {
  const bar = (width: number, paint: string): string => `<rect width="${width}" height="${METER_HEIGHT}" rx="${METER_HEIGHT / 2}" ${paint}/>`;
  const stops = meterStops(parts);
  const filled = parts
    .map((part, index) => ({ part, end: stops[index] as number, start: index === 0 ? 0 : (stops[index - 1] as number) }))
    .filter((segment) => segment.end > segment.start)
    .reverse()
    .map((segment) => bar(segment.end, `fill="${segment.part.colour}" fill-opacity="${segment.part.opacity ?? 1}"`))
    .join('');
  const track = bar(METER_WIDTH, `fill="${HUE.slate}" fill-opacity="0.28"`);
  return picture(svg(METER_WIDTH, METER_HEIGHT, `0 0 ${METER_WIDTH} ${METER_HEIGHT}`, track + filled), 'medidor');
}

const sign = (colour: string, mark: string): string =>
  svg(
    16,
    16,
    '0 0 16 16',
    `<circle cx="8" cy="8" r="7" fill="${colour}" fill-opacity="0.35"/>` +
      `<g fill="none" stroke="${colour}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${mark}</g>`,
  );
const SIGNS = {
  ghost: svg(
    26,
    26,
    '0 0 128 128',
    `<rect x="4" y="4" width="120" height="120" rx="30" fill="${HUE.night}"/>` +
      `<path d="M34 50a30 30 0 0 1 60 0v30a10 10 0 0 1-20 0 10 10 0 0 1-20 0 10 10 0 0 1-20 0Z" fill="${HUE.violet}"/>` +
      `<rect x="50" y="43" width="9" height="14" rx="4.5" fill="${HUE.night}"/><rect x="69" y="43" width="9" height="14" rx="4.5" fill="${HUE.night}"/>` +
      `<rect x="32" y="102" width="64" height="8" rx="4" fill="${HUE.teal}"/>`,
  ),
  gauge: sign(HUE.violet, `<path d="M8 8.5 11 5.2"/><circle cx="8" cy="8.5" r="0.9" fill="${HUE.violet}"/>`),
  clock: sign(HUE.blue, '<path d="M8 4.6V8l2.3 1.5"/>'),
  coin: sign(HUE.yellow, '<path d="M9.9 6.2C9.6 5.5 8.9 5.1 8 5.1c-1.1 0-1.9.6-1.9 1.4 0 1.8 3.8.9 3.8 2.9 0 .9-.8 1.5-1.9 1.5-.9 0-1.700-.4-2-1.200M8 3.800v8.400" stroke-width="1.3"/>'),
  check: sign(HUE.green, '<path d="M5 8.3l2.1 2.1 3.9-4.2"/>'),
};

function figure(drawing: string, value: string, of: string, bar: string, detail: string): string {
  return `### ${picture(drawing, '')}&nbsp; ${value} &nbsp;${small(`· ${of}`)}\n\n${bar ? `${bar}  \n` : ''}${small(detail)}`;
}

export function tooltipMarkdown(day: DayStats, session: SessionInfo): string {
  const state = session.paused ? 'en pausa' : session.triggerMode === 'manual' ? 'modo manual' : 'modo auto';
  const blocks: string[] = [`## ${picture(SIGNS.ghost, 'ghostline')}&nbsp; ghostline`, small(`Con Claude Code · ${state}`)];

  const warnings: string[] = [];
  if (session.cliError) warnings.push(`$(warning) ${plain(session.cliError)}`);
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
          SIGNS.gauge,
          dailyShare(day, session.dailyLimit),
          'de tu tope diario',
          meter([{ rate: day.requests / session.dailyLimit, colour: HUE.violet }]),
          `${day.requests} de ${session.dailyLimit} peticiones hoy`,
        )
      : figure(SIGNS.gauge, String(day.requests), 'peticiones hoy', '', 'sin tope diario'),
  );
  if (usesApiKey(session.apiKeySource)) {
    blocks.push(
      figure(
        SIGNS.coin,
        money(day.costUsd),
        'gastado hoy en la API',
        '',
        `con API key (${plain(session.apiKeySource ?? '')}) · ${formatTokens(totalTokens(day))} tokens`,
      ),
    );
  } else {
    const whole = session.rateLimit?.windows.five_hour?.utilization;
    const own = session.sessionBudgetUsd > 0 ? session.sessionSpentUsd / session.sessionBudgetUsd : 0;
    const ownShare = sessionShare(session);
    blocks.push(
      figure(
        SIGNS.clock,
        /^\d/.test(ownShare) && own > 0 ? `≈${ownShare}` : ownShare,
        'de la sesión de Claude (5 h)',
        meter([
          { rate: own, colour: HUE.violet },
          { rate: whole === undefined ? 0 : Math.max(0, whole - own), colour: HUE.blue, opacity: 0.6 },
        ]),
        `ghostline: ${usd(session.sessionSpentUsd)} de unos ${Math.round(session.sessionBudgetUsd)} $` +
          (whole === undefined ? '' : ` · la sesión entera va por el ${share(whole)}`),
      ),
    );
  }
  blocks.push(
    figure(
      SIGNS.check,
      percent(acceptanceRate(day)),
      'aceptadas',
      meter([{ rate: acceptanceRate(day) ?? 0, colour: HUE.green }]),
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

export const SLOW_P50_MS = 1500;

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
