import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_EXCLUDE_PATTERNS, globToRegExp, isPathExcluded } from '../../src/context/exclusions';

const excluded = (path: string): boolean => isPathExcluded(path, DEFAULT_EXCLUDE_PATTERNS);

test('default patterns exclude the usual secret files', () => {
  for (const path of [
    '/home/me/project/.env',
    '/home/me/project/.env.local',
    '/home/me/project/.env.production.local',
    'C:\\Users\\me\\project\\.env.local',
    '/p/certs/server.pem',
    '/p/certs/server.key',
    '/p/store.p12',
    '/p/store.pfx',
    '/home/me/.ssh/id_rsa',
    '/home/me/.ssh/id_rsa.pub',
    '/home/me/keys/id_ed25519',
    '/home/me/.ssh/config',
    '/home/me/.aws/credentials',
    '/home/me/.aws/sso/cache/token.json',
    '/p/src/secrets.ts',
    '/p/src/clientSecret.json',
    '/p/config/credentials.yml',
    '/p/google-credential.json',
    '/p/.npmrc',
    '/home/me/.pypirc',
    '/home/me/.netrc',
    '/p/passwords.kdbx',
    // Bare file names (untitled-like or relative paths).
    '.env',
    '.env.local',
  ]) {
    assert.equal(excluded(path), true, path);
  }
});

test('ordinary source files are not excluded', () => {
  for (const path of [
    '/p/src/index.ts',
    '/p/src/environment.ts',
    '/p/.envrc',
    '/p/src/env.ts',
    '/p/src/keyboard.ts',
    '/p/src/monkey.py',
    '/p/README.md',
    '/p/package.json',
    '/p/src/ssh/client.ts',
    '/p/aws/lambda.ts',
    'C:\\Users\\me\\project\\src\\app.tsx',
  ]) {
    assert.equal(excluded(path), false, path);
  }
});

test('matching is case-insensitive', () => {
  assert.equal(excluded('C:\\Proj\\.ENV'), true);
  assert.equal(excluded('/p/MySecretConfig.TS'), true);
  assert.equal(excluded('/p/Server.PEM'), true);
});

test('glob syntax: *, **, ?, braces and character classes', () => {
  const matches = (glob: string, path: string): boolean => globToRegExp(glob)?.test(path) ?? false;
  assert.equal(matches('**/*.ts', 'a/b/c.ts'), true);
  assert.equal(matches('**/*.ts', 'c.ts'), true);
  assert.equal(matches('**/*.ts', 'a/b/c.tsx'), false);
  assert.equal(matches('*.pem', 'deep/dir/x.pem'), true);
  assert.equal(matches('src/*.ts', 'src/a.ts'), true);
  assert.equal(matches('src/*.ts', 'src/sub/a.ts'), false);
  assert.equal(matches('src/**/*.ts', 'src/sub/deeper/a.ts'), true);
  assert.equal(matches('src/**', 'project/src/anything/at/all'), true);
  assert.equal(matches('**/file?.txt', 'x/file1.txt'), true);
  assert.equal(matches('**/file?.txt', 'x/file12.txt'), false);
  assert.equal(matches('**/*.{crt,cer}', 'x/a.cer'), true);
  assert.equal(matches('**/*.{crt,cer}', 'x/a.cert'), false);
  assert.equal(matches('**/id_[re]*', 'x/id_rsa'), true);
  assert.equal(matches('**/id_[!r]*', 'x/id_rsa'), false);
  // Regex metacharacters in a pattern are literal.
  assert.equal(matches('**/a+b(1).txt', 'x/a+b(1).txt'), true);
  assert.equal(matches('**/a.b', 'x/axb'), false);
});

test('broken or empty patterns never match and never throw', () => {
  assert.equal(isPathExcluded('/p/a.ts', ['', '   ', '**/[', '{', '**/{a,b']), false);
  assert.equal(isPathExcluded('/p/a.ts', []), false);
});

test('custom pattern lists replace the defaults', () => {
  assert.equal(isPathExcluded('/p/.env', ['**/*.sql']), false);
  assert.equal(isPathExcluded('/p/dump.sql', ['**/*.sql']), true);
});
