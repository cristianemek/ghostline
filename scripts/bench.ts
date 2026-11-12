// Measures ghostline against the REAL Claude Code CLI (it spends a few thousand tokens).
// It replays "the user is about to type this line" on this repository's own sources, through the same
// pool, prompt builder and post-processor the extension uses.
//
//   npm run bench -- [--n 12] [--mode single-use|persistent] [--model haiku] [--effort low]
//                    [--gap 1200] [--cache on|off] [--verbose]
//                    [--style]     learn this repo's style profile first and send it with every request
//                    [--examples]  feed back each original line as an accepted example (few-shot)
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { buildCliArgs, buildCliEnv } from '../src/cli/args';
import { resolveCli } from '../src/cli/resolveCli';
import { totalInputTokens, type InitInfo, type RateLimitInfo } from '../src/cli/streamParser';
import { CliWorker } from '../src/cli/worker';
import { WorkerPool, type WorkerMode } from '../src/cli/workerPool';
import { postprocess, shouldStopEarly } from '../src/completion/postprocess';
import { DEFAULT_LIMITS, buildPrompt } from '../src/completion/promptBuilder';
import { DEFAULT_SELECT, ExampleStore } from '../src/learning/exampleStore';
import { buildStylePrompt, cleanStyleGuide, pickStyleFiles } from '../src/learning/styleProfile';
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
const withStyle = process.argv.includes('--style');
const withExamples = process.argv.includes('--examples');
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

/** Same flow as the "Aprender estilo del proyecto" command, without the UI. */
async function learnStyle(command: string, cwd: string): Promise<string> {
  const root = process.cwd();
  const candidates = sourceFiles(join(root, 'src')).map((path) => ({
    path: relative(root, path).replace(/\\/g, '/'),
    size: statSync(path).size,
  }));
  const picked = pickStyleFiles(candidates);
  const files = picked.map((candidate) => ({ path: candidate.path, content: readFileSync(join(root, candidate.path), 'utf8') }));
  const prompt = buildStylePrompt(files);
  const worker = new CliWorker({
    command,
    args: buildCliArgs({ model, effort: 'low', systemPromptFile: resolve('resources', 'style-system-prompt.txt') }),
    cwd,
    env: buildCliEnv(process.env, { promptCache: false }),
  });
  const result = await worker.runTurn(prompt, { timeoutMs: 60_000 });
  if (worker.alive) worker.retire();
  if (result.status !== 'ok') throw new Error(`perfil de estilo: ${result.status} ${result.errorMessage ?? ''}`);
  const guide = cleanStyleGuide(result.text);
  console.log(`perfil de estilo: ${files.length} archivos (${files.map((file) => file.path).join(', ')})`);
  console.log(
    `  entrada ${totalInputTokens(result.usage)} tokens (${prompt.length} car.) · salida ${result.usage.outputTokens} · ` +
      `${Math.round(result.totalMs)} ms · ${result.costUsd.toFixed(5)} $ · perfil de ${guide.length} caracteres`,
  );
  console.log(guide.split('\n').map((line) => `  | ${line}`).join('\n') + '\n');
  return guide;
}

const GRADES = ['idéntica', 'casi', 'distinta', 'vacía'] as const;
type Grade = (typeof GRADES)[number];

/**
 * How close the first suggested line is to the line that was really there:
 * identical; "casi" = it starts the same way for most of the line, or it is the right line cut short
 * (what a user would accept and finish by hand); different; or nothing suggested.
 */
function gradeOf(got: string, expected: string): Grade {
  if (!got) return 'vacía';
  if (got === expected) return 'idéntica';
  let common = 0;
  while (common < got.length && common < expected.length && got[common] === expected[common]) common++;
  const startsAlike = common / expected.length >= 0.6;
  const rightButShort = expected.startsWith(got) && got.length >= expected.length * 0.4;
  return startsAlike || rightButShort ? 'casi' : 'distinta';
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

  const styleProfile = withStyle ? await learnStyle(resolved.command, cwd) : undefined;
  const memory = new Map<string, unknown>();
  const examples = new ExampleStore({ get: <T>(key: string) => memory.get(key) as T | undefined, update: (key, value) => void memory.set(key, value) });
  let requestsWithExamples = 0;
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
  const emptyTally = (): Record<Grade, number> => ({ idéntica: 0, casi: 0, distinta: 0, vacía: 0 });
  const grades: Record<Sample['kind'], Record<Grade, number>> = { 'línea nueva': emptyTally(), 'mitad de línea': emptyTally() };

  pool.warm();
  await sleep(gapMs);
  for (const [index, sample] of samples.entries()) {
    const built = buildPrompt({
      path: sample.path,
      languageId: 'typescript',
      prefix: sample.prefix,
      suffix: sample.suffix,
      styleProfile,
      examples: withExamples
        ? examples.select('typescript', sample.prefix.split('\n').slice(-6).join('\n'), { ...DEFAULT_SELECT, charsPerToken: estimator.charsPerToken })
        : undefined,
      limits: {
        ...DEFAULT_LIMITS,
        targetTokens: Math.max(300, TARGET_TOTAL - estimator.overheadTokens),
        charsPerToken: estimator.charsPerToken,
      },
    });
    const outcome = await pool.request(built.text, {
      shouldStop: (text) => shouldStopEarly(text, { maxLines: 6, prefix: built.prefix, languageId: 'typescript' }),
    });
    if (built.examplesUsed > 0) requestsWithExamples++;
    // As if the user had accepted the right completion here: it becomes an example for later requests.
    if (withExamples) examples.add('typescript', sample.prefix.split('\n').slice(-6).join('\n'), sample.expected);
    const label = `#${String(index + 1).padStart(2)} ${sample.kind.padEnd(14)}${built.examplesUsed > 0 ? ` +${built.examplesUsed}ej` : '    '}`;
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
      const grade = gradeOf(firstLine, sample.expected.trim());
      const tally = grades[sample.kind];
      tally[grade]++;
      console.log(
        `${label} entrada ${String(input).padStart(4)} (${built.chars} car.) · salida ${String(outcome.usage.outputTokens).padStart(3)} · ` +
          `1.er token ${round(outcome.firstTokenMs).padStart(4)} ms · total ${round(outcome.totalMs).padStart(4)} ms · ` +
          `proceso de ${round(outcome.workerAgeMs)} ms${outcome.numTurns > 1 ? ` · ${outcome.numTurns} turnos` : ''}${outcome.stoppedEarly ? ' · cortada' : ''} · ${grade}`,
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
  for (const kind of ['línea nueva', 'mitad de línea'] as const) {
    const tally = grades[kind];
    const total = GRADES.reduce((sum, grade) => sum + tally[grade], 0);
    console.log(`acierto ${kind.padEnd(14)} ${GRADES.map((grade) => `${grade} ${tally[grade]}`).join(' · ')}  (de ${total})`);
  }
  console.log(`calibración        ${estimator.charsPerToken.toFixed(2)} caracteres/token · sobrecarga ${Math.round(estimator.overheadTokens)} tokens`);
  if (withExamples) console.log(`ejemplos           ${requestsWithExamples} de ${samples.length} peticiones llevaron ejemplos · ${examples.count()} guardados`);
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
