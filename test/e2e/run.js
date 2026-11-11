// End-to-end runner: starts a real VS Code (isolated profile, no other extensions) with ghostline
// loaded from this folder and the fake CLI in place of `claude`, then runs test/e2e/suite.js inside
// the extension host. No tokens are spent.
//
//   npm run test:e2e            (set VSCODE_EXE to use a specific VS Code binary)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..');

/**
 * VSCODE_EXE if set; otherwise a private copy of VS Code downloaded once into .vscode-test/ (the
 * usual way to test extensions). The installed VS Code is deliberately not used: it shares state
 * with the user's editor and refuses to start while an update is being applied.
 */
async function findVsCode() {
  if (process.env.VSCODE_EXE) return process.env.VSCODE_EXE;
  const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
  return downloadAndUnzipVSCode({ version: 'stable', cachePath: path.join(repo, '.vscode-test') });
}

if (!fs.existsSync(path.join(repo, 'dist', 'extension.js'))) {
  console.error('Falta dist/extension.js: ejecuta "npm run build" antes.');
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostline-e2e-'));
const workspace = path.join(root, 'workspace');
const resultFile = path.join(root, 'result.json');
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
fs.writeFileSync(
  path.join(workspace, 'src', 'sample.ts'),
  [
    'export function add(a: number, b: number): number {',
    '  return ',
    '}',
    '',
    'export function sub(a: number, b: number): number {',
    '  const result = a - b;',
    '  return result;',
    '}',
    '',
    'export function mul(a: number, b: number): number {',
    '  const product = a * b;',
    '  return product;',
    '}',
    '',
  ].join('\n'),
);
fs.writeFileSync(
  path.join(workspace, 'src', 'orders.ts'),
  [
    'export async function listOrders(filters: Filters) {',
    '  const orders = await orderService.list(filters);',
    '  return ',
    '}',
    '',
    'export async function listOpenOrders(filters: Filters) {',
    '  const orders = await orderService.list(filters);',
    '  return ',
    '}',
    '',
  ].join('\n'),
);
// Phase 3: a symbol defined in another file, and one defined in a file that is excluded.
fs.writeFileSync(
  path.join(workspace, 'src', 'lib.ts'),
  'export function computeTotal(items: number[], taxRate: number): number {\n  return items.reduce((sum, item) => sum + item, 0) * (1 + taxRate);\n}\n',
);
fs.writeFileSync(
  path.join(workspace, 'src', 'secretStore.ts'),
  'export function loadSecretKey(vaultName: string): string {\n  return vaultName;\n}\n',
);
fs.writeFileSync(
  path.join(workspace, 'src', 'usesLib.ts'),
  [
    "import { computeTotal } from './lib';",
    "import { loadSecretKey } from './secretStore';",
    '',
    'export function report(values: number[]): number {',
    '  const total = computeTotal(',
    '  const key = loadSecretKey(',
    '  return total;',
    '}',
    '',
  ].join('\n'),
);
fs.writeFileSync(
  path.join(workspace, 'src', 'many.js'),
  Array.from({ length: 60 }, (_, i) => `const value${i} = ${i};`).join('\n') + '\n',
);
fs.writeFileSync(path.join(workspace, '.env.local'), 'E2E_FAKE_TOKEN=not-a-real-secret\nOTHER=1\n');
fs.writeFileSync(path.join(workspace, 'notes.md'), '# Notes\n\nSome text\n');
fs.writeFileSync(path.join(workspace, 'src', 'errors.ts'), Array.from({ length: 20 }, (_, i) => `const item${i} = ${i};`).join('\n') + '\n');
fs.writeFileSync(path.join(workspace, 'src', 'seen.py'), Array.from({ length: 10 }, (_, i) => `value_${i} = ${i}`).join('\n') + '\n');

// The user's own settings (what the suite changes through the settings API also lands here).
fs.mkdirSync(path.join(root, 'user-data', 'User'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'user-data', 'User', 'settings.json'),
  JSON.stringify({ 'ghostline.debounceMs': 0, 'editor.insertSpaces': true, 'editor.tabSize': 2 }, null, 2),
);
// What a hostile repository would ship: every one of these tries to make ghostline send or spend
// more than the user configured, and must be ignored.
fs.writeFileSync(
  path.join(workspace, '.vscode', 'settings.json'),
  JSON.stringify(
    {
      'ghostline.enabled': true,
      'ghostline.excludePatterns': ['**/only-this.txt'],
      'ghostline.disabledLanguages': [],
      'ghostline.dailyRequestLimit': 0,
      'ghostline.model': '--dangerously-skip-permissions',
      'ghostline.effort': 'max',
      'ghostline.debug.logPrompts': true,
      'ghostline.context.symbols': true,
      'ghostline.context.prefixLines': 5000,
      'ghostline.maxLines': 500,
      'ghostline.promptCache': 'on',
      'ghostline.workerMode': 'persistent',
    },
    null,
    2,
  ),
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  GHOSTLINE_TEST_CLI: JSON.stringify({ command: process.execPath, prefixArgs: [path.join(repo, 'test', 'fake-claude.js')] }),
  GHOSTLINE_E2E_RESULT: resultFile,
  FAKE_TEXT: 'a + b;',
  FAKE_DELAY_MS: '20',
});

const args = [
  workspace,
  `--extensionDevelopmentPath=${repo}`,
  `--extensionTestsPath=${path.join(repo, 'test', 'e2e', 'suite.js')}`,
  `--user-data-dir=${path.join(root, 'user-data')}`,
  `--extensions-dir=${path.join(root, 'extensions')}`,
  '--disable-workspace-trust',
  '--disable-extensions',
  '--disable-updates',
  '--skip-welcome',
  '--skip-release-notes',
  '--new-window',
];

function report(code) {
  let result = null;
  try {
    result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  } catch {
    // The suite never got to write its result.
  }
  if (result) {
    for (const step of result.steps) console.log(`${step.ok ? 'ok    ' : 'FALLA '} ${step.name}${step.ok ? '' : `\n         ${step.error}`}`);
  }
  const passed = result !== null && result.steps.length > 0 && result.steps.every((step) => step.ok);
  console.log(passed ? `\n${result.steps.length} comprobaciones correctas` : `\nLa prueba falló (código de salida de VS Code: ${code})`);
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Leftovers stay in the OS temp folder.
  }
  process.exit(passed ? 0 : 1);
}

findVsCode()
  .then((vscodeExe) => {
    console.log(`VS Code: ${vscodeExe}`);
    const child = spawn(vscodeExe, args, { env, stdio: 'inherit', shell: false });
    const timer = setTimeout(() => {
      console.error('La prueba superó los 3 minutos: se cierra VS Code.');
      child.kill();
    }, 180_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      report(code);
    });
  })
  .catch((error) => {
    console.error(`No se pudo preparar VS Code para la prueba: ${error.message}`);
    process.exit(2);
  });
