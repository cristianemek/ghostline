// Measures ghostline against the REAL Claude Code CLI (it spends a few thousand tokens).
// It replays "the user is about to type this line" on this repository's own sources, through the same
// pool, prompt builder and post-processor the extension uses.
//
//   npm run bench -- [--n 12] [--mode single-use|persistent] [--model haiku] [--effort low]
//                    [--gap 1200] [--cache on|off] [--verbose]
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { resolveCli } from '../src/cli/resolveCli';
import { totalInputTokens, type InitInfo, type RateLimitInfo } from '../src/cli/streamParser';
import { WorkerPool, type WorkerMode } from '../src/cli/workerPool';
import { postprocess, shouldStopEarly } from '../src/completion/postprocess';
import { DEFAULT_LIMITS, buildPrompt } from '../src/completion/promptBuilder';
import { TokenEstimator } from '../src/usage/tokenEstimator';
import { percentile } from '../src/usage/usageTracker';

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const count = Number(option('n', '12'));
const mode = option('mode', 'single-use') as WorkerMode;
const model = option('model', 'haiku');
const effort = option('effort', 'low');
const gapMs = Number(option('gap', '1200'));
const cache = option('cache', mode === 'persistent' ? 'on' : 'off') === 'on';
const verbose = process.argv.includes('--verbose');
// --env KEY=VALUE (repeatable): extra environment for the CLI processes, to compare configurations.
const extraEnv = Object.fromEntries(
  process.argv.flatMap((arg, index) => (arg === '--env' ? [(process.argv[index + 1] ?? '').split('=', 2) as [string, string]] : [])),
);
// --arg VALUE (repeatable): extra CLI arguments appended to the standard ones.
const extraArgs = process.argv.flatMap((arg, index) => (arg === '--arg' ? [process.argv[index + 1] ?? ''] : []));
// Absolute: the CLI runs in its own working folder, not here.
const systemPromptFile = resolve(option('system', join('resources', 'system-prompt.txt')));
const TARGET_TOTAL = 1900;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

/** Small deterministic generator so runs are comparable. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

interface Sample {
  path: string;
  kind: 'línea nueva' | 'mitad de línea';
  prefix: string;
  suffix: string;
  expected: string;
}

function makeSamples(total: number): Sample[] {
  const files = sourceFiles(join(process.cwd(), 'src')).map((path) => ({
    path: relative(process.cwd(), path).replace(/\\/g, '/'),
    lines: readFileSync(path, 'utf8').replace(/\r\n/g, '\n').split('\n'),
  }));
  const random = lcg(20261111);
  const samples: Sample[] = [];
  let guard = 0;
  while (samples.length < total && guard++ < 5000) {
    const file = files[Math.floor(random() * files.length)];
    if (!file || file.lines.length < 40) continue;
    const index = 20 + Math.floor(random() * (file.lines.length - 30));
    const line = file.lines[index] ?? '';
    const content = line.trim();
    if (content.length < 12 || content.startsWith('//') || content.startsWith('*') || content.startsWith('/*')) continue;
    const indent = line.slice(0, line.length - line.trimStart().length);
    const before = file.lines.slice(0, index).join('\n') + '\n';
    const after = '\n' + file.lines.slice(index + 1).join('\n');
    if (samples.length % 2 === 0) {
      samples.push({ path: file.path, kind: 'línea nueva', prefix: before + indent, suffix: after, expected: content });
    } else {
      // Cut after an early token boundary: "const x = ", "foo(", "this.".
      const cut = /[=(.]\s?/.exec(content.slice(4));
      if (!cut) continue;
      const at = 4 + cut.index + cut[0].length;
      samples.push({
        path: file.path,
        kind: 'mitad de línea',
        prefix: before + indent + content.slice(0, at),
        suffix: after,
        expected: content.slice(at),
      });
    }
  }
  return samples;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value: number | null | undefined): string => (value === undefined || value === null ? '–' : String(Math.round(value)));

async function main(): Promise<void> {
  const resolved = resolveCli('');
  if (!resolved.ok) {
    console.error(resolved.message);
    process.exit(1);
  }
  const cwd = mkdtempSync(join(tmpdir(), 'ghostline-cwd-'));
  const estimator = new TokenEstimator();
  let init: InitInfo | undefined;
  let rateLimit: RateLimitInfo | undefined;
  const pool = new WorkerPool(
    {
      command: resolved.command,
      model,
      effort,
      systemPromptFile,
      cwd,
      mode,
      recycleEvery: 8,
      requestTimeoutMs: 20_000,
      standbyMaxIdleMs: 600_000,
      promptCache: cache,
      env: { ...process.env, ...extraEnv },
      extraArgs,
    },
    {
      onInit: (info) => (init = info),
      onRateLimit: (info) => (rateLimit = info),
      log: (message) => console.log(`  [pool] ${message}`),
    },
  );

  console.log(`CLI: ${resolved.command} (${resolved.source})`);
  console.log(`modo ${mode} · modelo ${model} · effort ${effort} · caché de prompts ${cache ? 'on' : 'off'} · ${count} peticiones`);
  if (Object.keys(extraEnv).length > 0) console.log(`entorno extra: ${JSON.stringify(extraEnv)}`);
  console.log('');

  const samples = makeSamples(count);
  const totals: number[] = [];
  const firstTokens: number[] = [];
  const inputs: number[] = [];
  const outputs: number[] = [];
  let cost = 0;
  let exact = 0;
  let shown = 0;
  let failures = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let thinking = 0;

  pool.warm();
  await sleep(gapMs);
  for (const [index, sample] of samples.entries()) {
    const built = buildPrompt({
      path: sample.path,
      languageId: 'typescript',
      prefix: sample.prefix,
      suffix: sample.suffix,
      limits: {
        ...DEFAULT_LIMITS,
        fileTargetTokens: Math.max(300, TARGET_TOTAL - estimator.overheadTokens),
        charsPerToken: estimator.charsPerToken,
      },
    });
    const outcome = await pool.request(built.text, {
      shouldStop: (text) => shouldStopEarly(text, { maxLines: 6, prefix: built.prefix, languageId: 'typescript' }),
    });
    const label = `#${String(index + 1).padStart(2)} ${sample.kind.padEnd(14)}`;
    if (outcome.status !== 'ok') {
      failures++;
      console.log(`${label} ${outcome.status}: ${outcome.errorMessage ?? ''}`);
    } else {
      const input = totalInputTokens(outcome.usage);
      if (!outcome.usagePartial && outcome.numTurns <= 1) estimator.observe(built.chars, input);
      const text = postprocess({
        raw: outcome.text,
        prefix: built.prefix,
        suffix: built.suffix,
        maxLines: 6,
        indent: { insertSpaces: true, tabSize: 2 },
        languageId: 'typescript',
      });
      totals.push(outcome.totalMs);
      if (outcome.firstTokenMs !== null) firstTokens.push(outcome.firstTokenMs);
      inputs.push(input);
      outputs.push(outcome.usage.outputTokens);
      cost += outcome.costUsd;
      cacheRead += outcome.usage.cacheReadTokens;
      cacheWrite += outcome.usage.cacheWriteTokens;
      thinking += outcome.usage.thinkingTokens;
      if (text) shown++;
      const firstLine = text.split('\n')[0]?.trim() ?? '';
      const hit = firstLine !== '' && firstLine === sample.expected.trim();
      if (hit) exact++;
      console.log(
        `${label} entrada ${String(input).padStart(4)} (${built.chars} car.) · salida ${String(outcome.usage.outputTokens).padStart(3)} · ` +
          `1.er token ${round(outcome.firstTokenMs).padStart(4)} ms · total ${round(outcome.totalMs).padStart(4)} ms · ` +
          `proceso de ${round(outcome.workerAgeMs)} ms${outcome.numTurns > 1 ? ` · ${outcome.numTurns} turnos` : ''}${outcome.stoppedEarly ? ' · cortada' : ''} ${hit ? '· =' : ''}`,
      );
      if (verbose) {
        console.log(`     esperado: ${JSON.stringify(sample.expected.slice(0, 100))}`);
        console.log(`     obtenido: ${JSON.stringify(text.slice(0, 160))}${text ? '' : `  (bruto: ${JSON.stringify(outcome.text.slice(0, 80))})`}`);
      }
    }
    await sleep(gapMs);
  }
  pool.dispose();

  console.log('\n--- Resumen ---');
  console.log(`peticiones correctas: ${totals.length}/${samples.length} (${failures} fallidas)`);
  console.log(`latencia total     p50 ${round(percentile(totals, 50))} ms · p95 ${round(percentile(totals, 95))} ms`);
  console.log(`primer token       p50 ${round(percentile(firstTokens, 50))} ms · p95 ${round(percentile(firstTokens, 95))} ms`);
  console.log(`tokens de entrada  mediana ${round(percentile(inputs, 50))} · máx ${inputs.length ? Math.max(...inputs) : '–'}`);
  console.log(`tokens de salida   mediana ${round(percentile(outputs, 50))} · máx ${outputs.length ? Math.max(...outputs) : '–'}`);
  console.log(`caché              leídos ${cacheRead} · escritos ${cacheWrite} · razonamiento ${thinking}`);
  console.log(`coste equivalente  ${cost.toFixed(5)} $ en total · ${(cost / Math.max(1, totals.length)).toFixed(6)} $ por petición`);
  console.log(`sugerencias        ${shown} con texto · ${exact} con la primera línea idéntica al original`);
  console.log(`calibración        ${estimator.charsPerToken.toFixed(2)} caracteres/token · sobrecarga ${Math.round(estimator.overheadTokens)} tokens`);
  if (init) console.log(`init               modelo ${init.model} · apiKeySource ${init.apiKeySource} · tools ${init.tools.length} · mcp ${init.mcpServers.length}`);
  if (rateLimit) {
    const windows = Object.entries(rateLimit.windows).map(([name, window]) => `${name} ${Math.round(window.utilization * 100)}%`);
    console.log(`suscripción        ${windows.join(' · ')}`);
  }
  await sleep(1500);
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // The temp folder is cleaned up by the extension on its next start.
  }
}

void main();
