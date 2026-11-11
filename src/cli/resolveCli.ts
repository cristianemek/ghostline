import * as fs from 'node:fs';
import * as nodePath from 'node:path';

export interface ResolveEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  /** True when the path is an existing file. */
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

/**
 * The npm package installs `claude.cmd`, a batch shim whose only job is to start the real
 * `claude.exe` that ships inside the package. Find that executable so it can be launched directly.
 */
export function resolveNpmShim(shimPath: string, environment: ResolveEnvironment): string | null {
  const path = nodePath.win32;
  const dir = path.dirname(shimPath);
  const candidates: string[] = [];
  try {
    const text = environment.readFile(shimPath);
    // e.g.  "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
    const match = /"%(?:~dp0|dp0%)\\?([^"]+?\.exe)"/i.exec(text);
    if (match?.[1]) candidates.push(path.join(dir, match[1]));
  } catch {
    // Unreadable shim: fall through to the conventional location.
  }
  candidates.push(path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  // Whatever the shim says, the only thing ghostline will launch through it is a claude.exe.
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
    // A relative entry ("." or "bin") would resolve against whatever folder the editor runs in,
    // which lets a repository plant its own claude.exe.
    .filter((dir) => dir !== '' && path.isAbsolute(dir));
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  const binaryExts = extensions.filter((ext) => ext === '.exe' || ext === '.com');
  const batchExts = extensions.filter((ext) => ext === '.cmd' || ext === '.bat');

  // A real executable anywhere on PATH beats a batch shim, even one that comes earlier.
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
  // GUI-launched editors often miss the shell's PATH additions.
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

/** Locates the Claude Code executable. The result is always something that can be spawned with `shell: false`. */
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
