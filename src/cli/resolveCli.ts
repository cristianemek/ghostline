import * as fs from 'node:fs';
import * as nodePath from 'node:path';

export interface ResolveEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  isFile(path: string): boolean;
  readFile(path: string): string;
}

export type ResolveResult =
  | { ok: true; command: string; source: 'setting' | 'path' | 'npm-shim' | 'known-location' }
  | { ok: false; message: string };

const SHIM_HELP =
  'ghostline nunca lanza la CLI a través de un shell, así que no puede usar un .cmd/.bat. ' +
  'Instala Claude Code con el instalador nativo o pon en "ghostline.cliPath" la ruta al claude.exe.';

function isBatchFile(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path);
}

export function resolveNpmShim(shimPath: string, environment: ResolveEnvironment): string | null {
  const path = nodePath.win32;
  const dir = path.dirname(shimPath);
  const candidates: string[] = [];
  try {
    const text = environment.readFile(shimPath);
    const match = /"%(?:~dp0|dp0%)\\?([^"]+?\.exe)"/i.exec(text);
    if (match?.[1]) candidates.push(path.join(dir, match[1]));
  } catch {}
  candidates.push(path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  return (
    candidates.find((candidate) => path.basename(candidate).toLowerCase() === 'claude.exe' && environment.isFile(candidate)) ?? null
  );
}

function resolveWindows(environment: ResolveEnvironment): ResolveResult {
  const path = nodePath.win32;
  const { env } = environment;
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(';')
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter((dir) => dir !== '' && path.isAbsolute(dir));
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const binaryExts = extensions.filter((ext) => ext === '.exe' || ext === '.com');
  const batchExts = extensions.filter((ext) => ext === '.cmd' || ext === '.bat');

  for (const dir of dirs) {
    for (const ext of binaryExts) {
      const candidate = path.join(dir, `claude${ext}`);
      if (environment.isFile(candidate)) return { ok: true, command: candidate, source: 'path' };
    }
  }
  const native = path.join(environment.homeDir, '.local', 'bin', 'claude.exe');
  if (environment.isFile(native)) return { ok: true, command: native, source: 'known-location' };

  for (const dir of dirs) {
    for (const ext of batchExts) {
      const shim = path.join(dir, `claude${ext}`);
      if (!environment.isFile(shim)) continue;
      const target = resolveNpmShim(shim, environment);
      if (target) return { ok: true, command: target, source: 'npm-shim' };
      return { ok: false, message: `Solo se encontró ${shim}, que no apunta a un claude.exe. ${SHIM_HELP}` };
    }
  }
  return {
    ok: false,
    message:
      'No se encontró "claude" en PATH. Instala Claude Code o indica la ruta al ejecutable en "ghostline.cliPath".',
  };
}

function resolvePosix(environment: ResolveEnvironment): ResolveResult {
  const path = nodePath.posix;
  const dirs = (environment.env.PATH ?? '').split(':').filter((dir) => dir !== '' && path.isAbsolute(dir));
  for (const dir of dirs) {
    const candidate = path.join(dir, 'claude');
    if (environment.isFile(candidate)) return { ok: true, command: candidate, source: 'path' };
  }
  const known = [
    path.join(environment.homeDir, '.local', 'bin', 'claude'),
    path.join(environment.homeDir, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const candidate of known) {
    if (environment.isFile(candidate)) return { ok: true, command: candidate, source: 'known-location' };
  }
  return {
    ok: false,
    message:
      'No se encontró "claude" en PATH. Instala Claude Code o indica la ruta al ejecutable en "ghostline.cliPath".',
  };
}

export function resolveCli(cliPath: string, environment: ResolveEnvironment = defaultEnvironment()): ResolveResult {
  const configured = cliPath.trim();
  const windows = environment.platform === 'win32';
  if (configured) {
    if (!environment.isFile(configured)) {
      return { ok: false, message: `"ghostline.cliPath" apunta a un archivo que no existe: ${configured}` };
    }
    if (windows && isBatchFile(configured)) {
      const target = resolveNpmShim(configured, environment);
      if (target) return { ok: true, command: target, source: 'npm-shim' };
      return { ok: false, message: `"ghostline.cliPath" es un .cmd/.bat que no apunta a un claude.exe. ${SHIM_HELP}` };
    }
    return { ok: true, command: configured, source: 'setting' };
  }
  return windows ? resolveWindows(environment) : resolvePosix(environment);
}

export function defaultEnvironment(): ResolveEnvironment {
  return {
    platform: process.platform,
    env: process.env,
    homeDir: process.env.USERPROFILE ?? process.env.HOME ?? '',
    isFile: (path) => {
      try {
        return fs.statSync(path).isFile();
      } catch {
        return false;
      }
    },
    readFile: (path) => fs.readFileSync(path, 'utf8'),
  };
}
