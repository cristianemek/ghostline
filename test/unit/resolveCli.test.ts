import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCli, type ResolveEnvironment } from '../../src/cli/resolveCli';

function windows(files: Record<string, string>, env: NodeJS.ProcessEnv = {}): ResolveEnvironment {
  const lower = new Map(Object.entries(files).map(([path, content]) => [path.toLowerCase(), content]));
  return {
    platform: 'win32',
    env: { PATHEXT: '.COM;.EXE;.BAT;.CMD', ...env },
    homeDir: 'C:\\Users\\me',
    isFile: (path) => lower.has(path.toLowerCase()),
    readFile: (path) => {
      const content = lower.get(path.toLowerCase());
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
  };
}

function posix(files: string[], env: NodeJS.ProcessEnv = {}): ResolveEnvironment {
  return {
    platform: 'linux',
    env,
    homeDir: '/home/me',
    isFile: (path) => files.includes(path),
    readFile: () => '',
  };
}

const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join('\r\n');

const NPM_EXE = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';

test('windows: claude.exe on PATH is used directly', () => {
  const result = resolveCli('', windows({ 'C:\\bin\\claude.exe': '' }, { PATH: 'C:\\other;C:\\bin' }));
  assert.deepEqual(result, { ok: true, command: 'C:\\bin\\claude.exe', source: 'path' });
});

test('windows: an .exe later on PATH wins over a .cmd that comes first', () => {
  const env = windows(
    { 'C:\\npm\\claude.cmd': NPM_SHIM, [NPM_EXE]: '', 'C:\\native\\claude.exe': '' },
    { PATH: 'C:\\npm;C:\\native' },
  );
  assert.deepEqual(resolveCli('', env), { ok: true, command: 'C:\\native\\claude.exe', source: 'path' });
});

test('windows: the npm shim is resolved to the claude.exe it launches', () => {
  const env = windows({ 'C:\\npm\\claude.cmd': NPM_SHIM, [NPM_EXE]: '' }, { PATH: 'C:\\npm' });
  assert.deepEqual(resolveCli('', env), { ok: true, command: NPM_EXE, source: 'npm-shim' });
});

test('windows: Path (mixed case) and quoted entries are understood', () => {
  const env = windows({ 'C:\\Program Files\\cc\\claude.exe': '' }, { Path: '"C:\\Program Files\\cc";C:\\x' });
  const result = resolveCli('', env);
  assert.ok(result.ok);
  assert.equal(result.command, 'C:\\Program Files\\cc\\claude.exe');
});

test('windows: PATHEXT is respected', () => {
  // Without .EXE in PATHEXT the executable is not considered.
  const env = windows({ 'C:\\bin\\claude.exe': '' }, { PATH: 'C:\\bin', PATHEXT: '.CMD' });
  assert.equal(resolveCli('', env).ok, false);
});

test('windows: a shim that does not point to an .exe is refused with a clear message', () => {
  const legacy = '@ECHO off\r\nnode "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*';
  const result = resolveCli('', windows({ 'C:\\npm\\claude.cmd': legacy }, { PATH: 'C:\\npm' }));
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.message, /instalador nativo/);
  assert.match(result.message, /ghostline\.cliPath/);
});

test('windows: the native installer location is found even when it is not on PATH', () => {
  const env = windows({ 'C:\\Users\\me\\.local\\bin\\claude.exe': '' }, { PATH: 'C:\\nothing' });
  assert.deepEqual(resolveCli('', env), {
    ok: true,
    command: 'C:\\Users\\me\\.local\\bin\\claude.exe',
    source: 'known-location',
  });
});

test('windows: nothing found', () => {
  const result = resolveCli('', windows({}, { PATH: 'C:\\a;C:\\b' }));
  assert.ok(!result.ok);
  assert.match(result.message, /No se encontró/);
});

test('cliPath: used as is when it is an executable', () => {
  const env = windows({ 'D:\\tools\\claude.exe': '' }, { PATH: '' });
  assert.deepEqual(resolveCli('  D:\\tools\\claude.exe ', env), {
    ok: true,
    command: 'D:\\tools\\claude.exe',
    source: 'setting',
  });
});

test('cliPath: a missing file is an error, not a silent fallback to PATH', () => {
  const env = windows({ 'C:\\bin\\claude.exe': '' }, { PATH: 'C:\\bin' });
  const result = resolveCli('D:\\nope\\claude.exe', env);
  assert.ok(!result.ok);
  assert.match(result.message, /no existe/);
});

test('cliPath: a .cmd is resolved through the shim or refused, never launched', () => {
  const good = windows({ 'C:\\npm\\claude.cmd': NPM_SHIM, [NPM_EXE]: '' });
  assert.deepEqual(resolveCli('C:\\npm\\claude.cmd', good), { ok: true, command: NPM_EXE, source: 'npm-shim' });

  const bad = resolveCli('C:\\x\\claude.bat', windows({ 'C:\\x\\claude.bat': 'echo hi' }));
  assert.ok(!bad.ok);
  assert.match(bad.message, /shell/);
});

test('posix: first match on PATH, then well-known locations', () => {
  assert.deepEqual(resolveCli('', posix(['/usr/bin/claude', '/opt/x/claude'], { PATH: '/opt/x:/usr/bin' })), {
    ok: true,
    command: '/opt/x/claude',
    source: 'path',
  });
  assert.deepEqual(resolveCli('', posix(['/home/me/.local/bin/claude'], { PATH: '/usr/bin' })), {
    ok: true,
    command: '/home/me/.local/bin/claude',
    source: 'known-location',
  });
  assert.equal(resolveCli('', posix([], { PATH: '/usr/bin' })).ok, false);
});
