// Runs inside the VS Code extension host (see run.js). Exercises the real provider against real
// documents, settings and `vscode.languages.match`, with the fake CLI answering "a + b;".
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const AUTO = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic, selectedCompletionInfo: undefined };
const INVOKE = { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const steps = [];
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const extension = vscode.extensions.getExtension('cristianemek.ghostline');
  const api = await extension.activate();
  const settings = () => vscode.workspace.getConfiguration('ghostline');

  const open = async (relative) => {
    const document = await vscode.workspace.openTextDocument(path.join(workspace, relative));
    await vscode.window.showTextDocument(document);
    return document;
  };
  const ask = (document, line, character, context = AUTO) =>
    api.provider.provideInlineCompletionItems(
      document,
      new vscode.Position(line, character),
      context,
      new vscode.CancellationTokenSource().token,
    );
  const endOf = (document, line) => document.lineAt(line).text.length;
  const setting = async (name, value) => {
    await settings().update(name, value, vscode.ConfigurationTarget.Workspace);
    await sleep(150);
  };
  const step = async (name, body) => {
    try {
      await body();
      steps.push({ name, ok: true });
    } catch (error) {
      steps.push({ name, ok: false, error: String(error && error.message ? error.message : error).split('\n').slice(0, 6).join(' | ') });
    }
  };

  const sample = await open('src/sample.ts');
  let firstId;

  await step('auto: sugiere al final de la línea y cuenta la petición', async () => {
    const items = await ask(sample, 1, endOf(sample, 1));
    assert.equal(items?.length, 1);
    assert.equal(items[0].insertText, 'a + b;');
    assert.equal(items[0].command.command, 'ghostline._accepted');
    firstId = items[0].command.arguments[0];
    assert.equal(api.today().requests, 1);
    assert.equal(api.today().shown, 1);
  });

  await step('typeahead: al teclear el inicio de la sugerencia sirve el resto sin petición', async () => {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(sample.uri, new vscode.Position(1, endOf(sample, 1)), 'a +');
    await vscode.workspace.applyEdit(edit);
    const items = await ask(sample, 1, endOf(sample, 1));
    assert.equal(items?.length, 1);
    assert.equal(items[0].insertText, ' b;');
    assert.equal(items[0].command.arguments[0], firstId);
    assert.equal(api.today().requests, 1);
    assert.equal(api.today().localHits, 1);
  });

  await step('aceptar: el comando del item cuenta la sugerencia como aceptada', async () => {
    await vscode.commands.executeCommand('ghostline._accepted', firstId);
    assert.equal(api.today().accepted, 1);
    assert.ok(api.logLines().some((line) => line.includes('#1 ') && line.includes('aceptada')), 'falta la línea de log');
  });

  await step('caché: la misma posición no vuelve a gastar tokens', async () => {
    const edit = new vscode.WorkspaceEdit();
    edit.delete(sample.uri, new vscode.Range(1, 9, 1, endOf(sample, 1)));
    await vscode.workspace.applyEdit(edit);
    const items = await ask(sample, 1, endOf(sample, 1));
    assert.equal(items?.[0]?.insertText, 'a + b;');
    assert.equal(api.today().requests, 1);
  });

  await step('auto: no dispara en mitad de una línea; manual sí', async () => {
    assert.equal(await ask(sample, 5, 8), undefined);
    assert.equal(api.today().requests, 1);
    const items = await ask(sample, 5, 8, INVOKE);
    assert.equal(items?.length, 1);
    assert.equal(api.today().requests, 2);
  });

  await step('exclusiones: .env.local nunca genera una petición, ni en auto ni en manual', async () => {
    const secret = await open('.env.local');
    const before = api.today().requests;
    assert.equal(await ask(secret, 0, endOf(secret, 0)), undefined);
    assert.equal(await ask(secret, 0, endOf(secret, 0), INVOKE), undefined);
    assert.equal(await ask(secret, 1, 0, INVOKE), undefined);
    assert.equal(api.today().requests, before);
    assert.ok(!api.logLines().some((line) => line.includes('E2E_FAKE_TOKEN')), 'el contenido llegó al log');
  });

  await step('lenguajes desactivados: markdown no dispara en auto, sí en manual', async () => {
    const notes = await open('notes.md');
    const before = api.today().requests;
    assert.equal(await ask(notes, 2, endOf(notes, 2)), undefined);
    assert.equal(api.today().requests, before);
    const items = await ask(notes, 2, endOf(notes, 2), INVOKE);
    assert.equal(items?.length, 1);
    assert.equal(api.today().requests, before + 1);
  });

  await step('modo manual: ignora los disparos automáticos y responde a la invocación', async () => {
    await open('src/sample.ts');
    await setting('triggerMode', 'manual');
    const before = api.today().requests;
    assert.equal(await ask(sample, 6, endOf(sample, 6)), undefined);
    assert.equal(api.today().requests, before);
    assert.match(api.statusText(), /^ghostline \(manual\) /);
    const items = await ask(sample, 6, endOf(sample, 6), INVOKE);
    assert.equal(items?.length, 1);
    assert.equal(api.today().requests, before + 1);
    await setting('triggerMode', 'auto');
  });

  await step('barra de estado: peticiones · tokens · % de aceptadas', async () => {
    assert.match(api.statusText(), /^ghostline 4 · [\d.]+k? tok · \d+% ✓$/);
  });

  await step('límite diario: pausa el modo auto, lo indica y el manual sigue funcionando', async () => {
    await setting('dailyRequestLimit', api.today().requests);
    const before = api.today().requests;
    assert.equal(await ask(sample, 10, endOf(sample, 10)), undefined);
    assert.equal(api.today().requests, before);
    assert.match(api.statusText(), /^\$\(circle-slash\) ghostline/);
    const items = await ask(sample, 10, endOf(sample, 10), INVOKE);
    assert.equal(items?.length, 1);
    assert.equal(api.today().requests, before + 1);
    await setting('dailyRequestLimit', 1500);
  });

  await step('pausa: sin sugerencias automáticas hasta reanudar', async () => {
    await vscode.commands.executeCommand('ghostline.togglePause');
    const before = api.today().requests;
    assert.equal(await ask(sample, 11, endOf(sample, 11)), undefined);
    assert.equal(api.today().requests, before);
    assert.match(api.statusText(), /^\$\(debug-pause\) ghostline/);
    await vscode.commands.executeCommand('ghostline.togglePause');
    const items = await ask(sample, 11, endOf(sample, 11));
    assert.equal(items?.length, 1);
  });

  await step('log: una línea por petición, con tiempos y tokens, sin el contenido del archivo', async () => {
    const requestLines = api.logLines().filter((line) => /^\[\d\d:\d\d:\d\d\] #\d+ /.test(line));
    assert.ok(requestLines.length >= 4, `solo ${requestLines.length} líneas`);
    for (const line of requestLines) {
      assert.match(line, /espera \d+ ms · primer token \d+ ms · total \d+ ms · tokens: entrada \d+, salida \d+/);
      assert.ok(!line.includes('export function'), 'el prompt aparece en el log');
    }
    assert.ok(api.logLines().some((line) => line.includes('apiKeySource none')));
  });

  // --- Fase 2 -----------------------------------------------------------------------------------

  const lastPrompt = () => {
    const lines = api.logLines().filter((line) => / prompt \(\d+ caracteres/.test(line));
    return lines[lines.length - 1] ?? '';
  };

  await step('ejemplos: lo aceptado se guarda en local y se envía como ejemplo en código parecido', async () => {
    await setting('debug.logPrompts', true);
    const orders = await open('src/orders.ts');
    const before = api.exampleCount();
    const first = await ask(orders, 2, endOf(orders, 2));
    assert.equal(first?.length, 1);
    assert.ok(!lastPrompt().includes('<examples>'), 'no debería haber ejemplos todavía');
    await vscode.commands.executeCommand('ghostline._accepted', first[0].command.arguments[0]);
    assert.equal(api.exampleCount(), before + 1);

    const second = await ask(orders, 7, endOf(orders, 7));
    assert.equal(second?.length, 1);
    const prompt = lastPrompt();
    assert.ok(prompt.includes('<examples>'), 'el prompt no lleva ejemplos');
    assert.ok(prompt.includes('<accepted>a + b;</accepted>'), 'falta el texto aceptado');
    assert.ok(prompt.includes('orderService.list(filters);'), 'falta el contexto del ejemplo');
    // The examples come before the file, as the spec orders the blocks.
    assert.ok(prompt.indexOf('<examples>') < prompt.indexOf('<file path='));
  });

  await step('perfil de estilo: se genera con la CLI, se guarda y va primero en cada prompt', async () => {
    const before = api.today().requests;
    const guide = await api.learnStyleFrom([path.join(workspace, 'src', 'sample.ts'), path.join(workspace, 'src', 'orders.ts')]);
    assert.equal(guide, 'a + b;');
    assert.equal(api.styleProfile(), 'a + b;');
    assert.equal(api.today().requests, before + 1);
    assert.ok(api.logLines().some((line) => line.includes('perfil de estilo generado a partir de 2 archivos')));

    const sampleAgain = await open('src/sample.ts');
    const items = await ask(sampleAgain, 12, endOf(sampleAgain, 12));
    assert.equal(items?.length, 1);
    const prompt = lastPrompt();
    const body = prompt.slice(prompt.indexOf('\n') + 1);
    assert.ok(body.startsWith('<style>\na + b;\n</style>\n'), `el bloque estable no va primero: ${body.slice(0, 60)}`);
  });

  await step('perfil de estilo: un archivo excluido nunca se envía', async () => {
    const before = api.today().requests;
    await assert.rejects(api.learnStyleFrom([path.join(workspace, '.env.local')]), /ningún archivo utilizable/);
    assert.equal(api.today().requests, before);
  });

  await step('disparo adaptativo: tras 40 sugerencias ignoradas deja de disparar ahí; el manual sigue', async () => {
    await setting('debug.logPrompts', false);
    const many = await open('src/many.js');
    let shown = 0;
    let line = 0;
    for (; line < 50; line++) {
      const items = await ask(many, line, endOf(many, line));
      if (!items) break;
      shown++;
    }
    assert.equal(shown, 40, `se mostraron ${shown} sugerencias antes de silenciar`);
    const before = api.today().requests;
    assert.equal(await ask(many, line + 1, endOf(many, line + 1)), undefined);
    assert.equal(api.today().requests, before);
    assert.ok(api.logLines().some((entry) => entry.includes('disparo adaptativo') && entry.includes('javascript')));
    const manual = await ask(many, line + 1, endOf(many, line + 1), INVOKE);
    assert.equal(manual?.length, 1);
    // Another language is not affected.
    const sampleAgain = await open('src/sample.ts');
    assert.equal((await ask(sampleAgain, 2, endOf(sampleAgain, 2)))?.length, 1);
  });

  fs.writeFileSync(process.env.GHOSTLINE_E2E_RESULT, JSON.stringify({ steps }));
  const failed = steps.filter((item) => !item.ok);
  if (failed.length > 0) throw new Error(`${failed.length} comprobaciones fallidas`);
}

exports.run = run;
