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
  // Always the user's settings: most of ghostline's settings cannot be set by a workspace at all.
  const setting = async (name, value) => {
    await settings().update(name, value, vscode.ConfigurationTarget.Global);
    await sleep(150);
  };
  // The suite asks for suggestions back to back; without this none would count as "seen".
  api.provider.minVisibleMs = 0;
  const step = async (name, body) => {
    try {
      await body();
      steps.push({ name, ok: true });
    } catch (error) {
      steps.push({ name, ok: false, error: String(error && error.message ? error.message : error).split('\n').slice(0, 6).join(' | ') });
    }
  };

  await step('seguridad: los ajustes que trae un repositorio no pueden hacer que ghostline envíe o gaste más', async () => {
    // .vscode/settings.json of this workspace sets hostile values for all of these (see run.js).
    const config = api.config();
    assert.equal(config.model, 'haiku');
    assert.equal(config.effort, 'low');
    assert.equal(config.dailyRequestLimit, 1500);
    assert.equal(config.logPrompts, false);
    assert.equal(config.symbolContext, false);
    assert.equal(config.promptCache, 'auto');
    assert.equal(config.workerMode, 'single-use');
    assert.equal(config.prefixLines, 60);
    assert.equal(config.maxLines, 6);
    // Exclusions and disabled languages add up; the defaults are still there.
    assert.ok(config.excludePatterns.includes('**/.env.*'));
    assert.ok(config.excludePatterns.includes('**/only-this.txt'));
    assert.ok(config.disabledLanguages.includes('markdown'));
  });

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

  await step('auto: en mitad de una línea solo dispara justo donde se acaba de teclear, y se puede apagar', async () => {
    // "  return result;" → "  return x, result;" typed one character at a time, as a keyboard would.
    const type = async (line, character, text) => {
      for (const [index, char] of [...text].entries()) {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(sample.uri, new vscode.Position(line, character + index), char);
        await vscode.workspace.applyEdit(edit);
      }
      await sleep(50);
    };
    const before = api.today().requests;
    await type(6, 9, 'x, ');
    // Somewhere else on the line, or inside a word: nothing.
    assert.equal(await ask(sample, 6, 2), undefined);
    assert.equal(await ask(sample, 6, 14), undefined);
    assert.equal(api.today().requests, before);
    await setting('midLine', false);
    assert.equal(await ask(sample, 6, 12), undefined);
    assert.equal(api.today().requests, before);
    await setting('midLine', true);
    const items = await ask(sample, 6, 12);
    assert.equal(items?.length, 1);
    assert.equal(items[0].insertText, 'a + b;');
    assert.equal(api.today().requests, before + 1);
    assert.ok(api.logLines().some((line) => line.includes(' typescript mid-line ')), 'falta el contexto mid-line en el log');
    // A paste is not typing.
    const paste = new vscode.WorkspaceEdit();
    paste.insert(sample.uri, new vscode.Position(10, 8), 'value, other, ');
    await vscode.workspace.applyEdit(paste);
    await sleep(50);
    assert.equal(await ask(sample, 10, 22), undefined);
    assert.equal(api.today().requests, before + 1);
    // Leave the file as it was for the steps that follow.
    const undo = new vscode.WorkspaceEdit();
    undo.delete(sample.uri, new vscode.Range(10, 8, 10, 22));
    undo.delete(sample.uri, new vscode.Range(6, 9, 6, 12));
    await vscode.workspace.applyEdit(undo);
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

  await step('barra de estado: % del tope diario propio · % de una sesión de Claude gastado por ghostline', async () => {
    // 5 requests out of 1.500, and what they cost against a session worth 80 $.
    assert.match(api.statusText(), /^ghostline <1% · Claude (0%|<0,01%|\d+(,\d+)?%)$/);
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

  await step('tras aceptar: no se vuelve a pedir en el mismo punto hasta la siguiente tecla', async () => {
    const doc = await open('src/accept.ts');
    const before = api.today().requests;
    const items = await ask(doc, 0, endOf(doc, 0));
    assert.equal(items?.length, 1);
    // What accepting does: the text goes into the document, then the item's command runs.
    const insert = async (text) => {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, endOf(doc, 0)), text);
      await vscode.workspace.applyEdit(edit);
      await sleep(50);
    };
    await insert(items[0].insertText);
    await vscode.commands.executeCommand('ghostline._accepted', items[0].command.arguments[0]);
    assert.equal(await ask(doc, 0, endOf(doc, 0)), undefined);
    assert.equal(api.today().requests, before + 1);
    // Elsewhere in the file nothing is held back, and the manual trigger always asks.
    assert.equal((await ask(doc, 1, endOf(doc, 1)))?.length, 1);
    await ask(doc, 0, endOf(doc, 0), INVOKE);
    assert.equal(api.today().requests, before + 3);
    await insert(' ');
    assert.equal((await ask(doc, 0, endOf(doc, 0)))?.length, 1);
    assert.equal(api.today().requests, before + 4);
    await open('src/sample.ts');
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

  await step('disparo adaptativo: una sugerencia que desaparece al instante no cuenta como ignorada', async () => {
    const seen = await open('src/seen.py');
    const python = () => api.adaptiveReport().find((entry) => entry.languageId === 'python' && entry.context === 'end-of-line');
    api.provider.minVisibleMs = 750;
    try {
      assert.equal((await ask(seen, 0, endOf(seen, 0)))?.length, 1);
      // The next request arrives right away: the first suggestion was never really on screen.
      assert.equal((await ask(seen, 1, endOf(seen, 1)))?.length, 1);
      assert.equal(python()?.shown ?? 0, 0);
      // This one stays up long enough to have been read, and is then passed over.
      await sleep(900);
      assert.equal((await ask(seen, 2, endOf(seen, 2)))?.length, 1);
      assert.equal(python()?.shown, 1);
      assert.equal(python()?.accepted, 0);
    } finally {
      api.provider.minVisibleMs = 0;
    }
  });

  await step('errores repetidos: pausa las peticiones automáticas, lo indica y se recupera sola', async () => {
    const errors = await open('src/errors.ts');
    let line = 0;
    const next = (context) => ask(errors, line, endOf(errors, line), context);
    try {
      // New CLI processes will now fail like a logged-out CLI. The one already waiting was launched
      // before the change and still answers: use it up.
      process.env.FAKE_MODE = 'error';
      assert.equal((await next())?.length, 1);
      line++;
      let before = api.today().requests;
      for (let i = 0; i < 3; i++, line++) assert.equal(await next(), undefined);
      assert.equal(api.today().requests, before + 3);

      // Paused: no process is launched, no request is counted.
      before = api.today().requests;
      assert.equal(await next(), undefined);
      line++;
      assert.equal(await next(), undefined);
      assert.equal(api.today().requests, before);
      assert.match(api.statusText(), /^\$\(warning\) ghostline /);
      assert.ok(api.logLines().some((entry) => entry.includes('en pausa') && entry.includes('Invalid API key')));

      // A manual request is never blocked…
      assert.equal(await next(INVOKE), undefined);
      assert.equal(api.today().requests, before + 1);
      // …and once the CLI works again (after the broken process that was left waiting), it closes the pause.
      process.env.FAKE_MODE = 'ok';
      assert.equal(await next(INVOKE), undefined);
      assert.equal((await next(INVOKE))?.length, 1);
      line++;
      assert.equal((await next())?.length, 1);
      assert.doesNotMatch(api.statusText(), /^\$\(warning\)/);
    } finally {
      delete process.env.FAKE_MODE;
    }
  });

  // --- Latencia ---------------------------------------------------------------------------------

  /** A provider call whose token can be cancelled, as the editor does on the next keystroke. */
  const askCancellable = (document, line, character) => {
    const source = new vscode.CancellationTokenSource();
    return {
      cancel: () => source.cancel(),
      result: api.provider.provideInlineCompletionItems(document, new vscode.Position(line, character), AUTO, source.token),
    };
  };
  const typeAt = async (document, line, text) => {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(line, endOf(document, line)), text);
    await vscode.workspace.applyEdit(edit);
  };

  await step('latencia: seguir tecleando lo que el modelo responde aprovecha la petición ya lanzada', async () => {
    const flight = await open('src/flight.ts');
    try {
      // New CLI processes answer after 700 ms; the one already waiting is still fast: use it up.
      process.env.FAKE_DELAY_MS = '700';
      assert.equal((await ask(flight, 0, endOf(flight, 0)))?.length, 1);

      const before = api.today().requests;
      const first = askCancellable(flight, 1, endOf(flight, 1));
      await sleep(200);
      // The user types "a +", which is how the answer ("a + b;") begins. The editor cancels the call.
      first.cancel();
      assert.equal(await first.result, undefined);
      await typeAt(flight, 1, 'a +');
      const started = Date.now();
      const items = await ask(flight, 1, endOf(flight, 1));
      const waited = Date.now() - started;
      assert.equal(items?.[0]?.insertText, ' b;');
      // One request served both positions, and it landed sooner than a new one could have.
      assert.equal(api.today().requests, before + 1);
      assert.ok(waited < 650, `tardó ${waited} ms`);
    } finally {
      delete process.env.FAKE_DELAY_MS;
    }
  });

  await step('latencia: una respuesta que llega mientras tecleas se guarda y se pide al editor que la muestre', async () => {
    const flight = await open('src/flight.ts');
    try {
      process.env.FAKE_DELAY_MS = '500';
      assert.equal((await ask(flight, 3, endOf(flight, 3)))?.length, 1); // uses up the 700 ms process
      assert.equal((await ask(flight, 4, endOf(flight, 4)))?.length, 1); // …and the next one waiting

      const before = api.today().requests;
      const shownBefore = api.today().shown;
      const refreshes = api.refreshCount();
      const first = askCancellable(flight, 5, endOf(flight, 5));
      await sleep(100);
      first.cancel();
      await typeAt(flight, 5, 'a');
      // The real cursor sits where the user stopped typing.
      const end = new vscode.Position(5, endOf(flight, 5));
      vscode.window.activeTextEditor.selection = new vscode.Selection(end, end);
      // Nobody asks while the answer is on its way. When it lands, ghostline asks the editor to
      // trigger again, and the editor itself calls the provider, which shows what is left of it.
      await sleep(1000);
      assert.equal(api.refreshCount(), refreshes + 1);
      assert.equal(api.today().shown, shownBefore + 1, 'el editor no volvió a pedir la sugerencia');
      // Typing on, or asking again, is served from it: still a single request.
      const items = await ask(flight, 5, endOf(flight, 5));
      assert.equal(items?.[0]?.insertText, ' + b;');
      assert.equal(api.today().requests, before + 1);
    } finally {
      delete process.env.FAKE_DELAY_MS;
      // The editor now has a real suggestion on screen and would keep asking on its own as the
      // document changes. Close it and park the cursor where automatic requests never fire, so the
      // remaining steps only see the calls they make themselves.
      await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
      const home = new vscode.Position(0, 0);
      vscode.window.activeTextEditor.selection = new vscode.Selection(home, home);
      await sleep(200);
    }
  });

  await step('latencia: si lo tecleado no coincide con la respuesta, se descarta y se pide de nuevo sin esperar', async () => {
    const flight = await open('src/flight.ts');
    try {
      process.env.FAKE_DELAY_MS = '400';
      assert.equal((await ask(flight, 7, endOf(flight, 7)))?.length, 1);
      assert.equal((await ask(flight, 8, endOf(flight, 8)))?.length, 1);

      const before = api.today().requests;
      const first = askCancellable(flight, 9, endOf(flight, 9));
      await sleep(100);
      first.cancel();
      await typeAt(flight, 9, 'zzz');
      const items = await ask(flight, 9, endOf(flight, 9));
      // The first answer ("a + b;") is useless after "zzz"; a second request answers for the new position.
      assert.equal(items?.[0]?.insertText, 'a + b;');
      assert.equal(api.today().requests, before + 2);
      // A cursor that moves elsewhere drops whatever is in the air. The request had already been sent
      // and the CLI reports nothing for it: its tokens are kept apart as an estimate, not counted as free.
      const unconfirmed = api.today().unconfirmedTokens;
      const moved = askCancellable(flight, 11, endOf(flight, 11));
      await sleep(250);
      moved.cancel();
      const editor = vscode.window.activeTextEditor;
      editor.selection = new vscode.Selection(new vscode.Position(11, endOf(flight, 11)), new vscode.Position(11, endOf(flight, 11)));
      editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
      await sleep(700);
      assert.equal(await ask(flight, 0, 0), undefined);
      assert.ok(api.logLines().some((line) => line.includes('cancelada')));
      assert.ok(api.today().unconfirmedTokens > unconfirmed, 'la petición cortada no se anotó como sin confirmar');
    } finally {
      delete process.env.FAKE_DELAY_MS;
    }
  });

  await step('latencia: espera corta en una línea vacía, ninguna tras aceptar, completa dentro de la línea', async () => {
    const pace = await open('src/pace.ts');
    await sleep(600); // let the slow processes of the previous step drain
    await ask(pace, 1, endOf(pace, 1));
    await ask(pace, 3, endOf(pace, 3));
    await setting('debounceMs', 600);
    try {
      const timed = async (line) => {
        const started = Date.now();
        const items = await ask(pace, line, endOf(pace, line));
        return { items, ms: Date.now() - started };
      };
      // "const partial4": in the middle of a word, the full 600 ms.
      const midWord = await timed(4);
      assert.equal(midWord.items?.length, 1);
      assert.ok(midWord.ms >= 580, `mitad de palabra: ${midWord.ms} ms`);
      // "const total5 = ": inside a line the wait is the full one too, even right after "=".
      const insideLine = await timed(5);
      assert.equal(insideLine.items?.length, 1);
      assert.ok(insideLine.ms >= 580, `dentro de la línea: ${insideLine.ms} ms`);
      // By default nothing is anticipated: an empty line waits like any other place.
      const emptyByDefault = await timed(12);
      assert.equal(emptyByDefault.items?.length, 1);
      assert.ok(emptyByDefault.ms >= 580, `línea vacía, por defecto: ${emptyByDefault.ms} ms`);
      api.provider.clearCache();
      // With "line", an empty line gets the short wait: one bet per new line.
      await setting('speculation', 'line');
      const emptyLine = await timed(12);
      assert.equal(emptyLine.items?.length, 1);
      assert.ok(emptyLine.ms >= 110 && emptyLine.ms < 520, `línea vacía: ${emptyLine.ms} ms`);
      // Right after accepting, no wait at all, even in the middle of a word.
      await vscode.commands.executeCommand('ghostline._accepted', emptyLine.items[0].command.arguments[0]);
      const afterAccept = await timed(8);
      assert.equal(afterAccept.items?.length, 1);
      assert.ok(afterAccept.ms < 450, `tras aceptar: ${afterAccept.ms} ms`);
      // With speculation off nothing is anticipated: the original behaviour.
      await setting('speculation', 'off');
      const off = await timed(9);
      assert.equal(off.items?.length, 1);
      assert.ok(off.ms >= 580, `sin especulación: ${off.ms} ms`);
    } finally {
      await setting('speculation', undefined);
      await setting('debounceMs', 0);
    }
  });

  // --- Fase 3 -----------------------------------------------------------------------------------

  await step('símbolos: la firma de una definición de otro archivo llega al prompt; de un archivo excluido, nunca', async () => {
    await setting('context.symbols', true);
    await setting('debug.logPrompts', true);
    const uses = await open('src/usesLib.ts');
    const column = uses.lineAt(4).text.indexOf('computeTotal');
    // The TypeScript server needs a moment after the first file opens.
    let ready = false;
    for (let attempt = 0; attempt < 80 && !ready; attempt++) {
      const found = await vscode.commands.executeCommand(
        'vscode.executeDefinitionProvider',
        uses.uri,
        new vscode.Position(4, column + 2),
      );
      ready = Array.isArray(found) && found.length > 0;
      if (!ready) await sleep(500);
    }
    assert.ok(ready, 'el servidor de TypeScript no resolvió la definición en 40 s');

    // The lookup has 300 ms; a cold first try just leaves the answer cached for the next one.
    let prompt = '';
    for (let attempt = 0; attempt < 4 && !prompt.includes('<symbols>'); attempt++) {
      api.provider.clearCache();
      const items = await ask(uses, 4, endOf(uses, 4));
      assert.equal(items?.length, 1);
      prompt = lastPrompt();
      if (!prompt.includes('<symbols>')) await sleep(400);
    }
    assert.ok(
      prompt.includes('<symbols>\nexport function computeTotal(items: number[], taxRate: number): number  // src/lib.ts\n</symbols>'),
      `símbolos inesperados: ${prompt.slice(0, 300)}`,
    );
    assert.ok(prompt.indexOf('<symbols>') < prompt.indexOf('<file path='));

    // Defined in src/secretStore.ts, which matches the default exclusions: its signature stays local.
    const secretColumn = uses.lineAt(5).text.indexOf('loadSecretKey');
    const secretDefinition = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      uses.uri,
      new vscode.Position(5, secretColumn + 2),
    );
    assert.ok(Array.isArray(secretDefinition) && secretDefinition.length > 0, 'la definición excluida debería existir');
    for (let attempt = 0; attempt < 2; attempt++) {
      api.provider.clearCache();
      assert.equal((await ask(uses, 5, endOf(uses, 5)))?.length, 1);
      assert.ok(!lastPrompt().includes('vaultName'), 'la firma de un archivo excluido llegó al prompt');
      await sleep(400);
    }
    // The cursor inside a literal opened on the line above: the type named there comes with its
    // members (names and types), read by ghostline through the language server.
    prompt = '';
    for (let attempt = 0; attempt < 4 && !prompt.includes('ReportOptions {'); attempt++) {
      api.provider.clearCache();
      assert.equal((await ask(uses, 10, 2))?.length, 1);
      prompt = lastPrompt();
      if (!prompt.includes('ReportOptions {')) await sleep(400);
    }
    assert.ok(
      prompt.includes('<symbols>\nexport interface ReportOptions { title: string; taxRate: number; currency?: string }  // src/lib.ts\n</symbols>'),
      `campos inesperados: ${prompt.slice(0, 300)}`,
    );
    await setting('context.symbols', false);
    await setting('debug.logPrompts', false);
  });

  fs.writeFileSync(process.env.GHOSTLINE_E2E_RESULT, JSON.stringify({ steps }));
  const failed = steps.filter((item) => !item.ok);
  if (failed.length > 0) throw new Error(`${failed.length} comprobaciones fallidas`);
}

exports.run = run;
