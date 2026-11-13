const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const AUTO = { triggerKind: vscode.InlineCompletionTriggerKind.Automatic, selectedCompletionInfo: undefined };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HESITATION_MS = 420;
const KEY_MS = 95;
const BOUNDARY_MS = 230;
const GIVE_UP_MS = 6000;
const MODES = (process.env.GHOSTLINE_TYPING_MODES || 'off,line').split(',');

function pickLines(lines, count) {
  const usable = [];
  for (let index = 12; index < lines.length - 8; index++) {
    const content = lines[index].trim();
    if (content.length < 26 || content.length > 72) continue;
    if (/^(\/\/|\*|\/\*|import |export |\}|\{)/.test(content)) continue;
    usable.push(index);
  }
  const step = Math.max(1, Math.floor(usable.length / count));
  return usable.filter((_, i) => i % step === 0).slice(0, count);
}

function stopIndex(content) {
  for (let i = Math.floor(content.length * 0.33); i < content.length - 4; i++) {
    if (/[ .(=,]/.test(content[i])) return i + 1;
  }
  return Math.floor(content.length / 2);
}

async function run() {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const api = await vscode.extensions.getExtension('cristianemek.ghostline').activate();
  const file = path.join(workspace, 'src', 'typing.ts');
  const original = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const sourceLines = original.split('\n');
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);
  const settings = vscode.workspace.getConfiguration('ghostline');
  const count = Number(process.env.GHOSTLINE_TYPING_LINES || 8);
  const rows = [];

  const setAll = async (text) => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
    await vscode.workspace.applyEdit(edit);
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
    await vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
  };

  async function typeLine(lineIndex, mode) {
    const full = sourceLines[lineIndex];
    const indent = full.slice(0, full.length - full.trimStart().length);
    const content = full.trimStart();
    const typed = content.slice(0, stopIndex(content));
    await setAll([...sourceLines.slice(0, lineIndex), indent, ...sourceLines.slice(lineIndex + 1)].join('\n'));
    api.provider.clearCache();
    api.provider.dismiss();
    await settings.update('speculation', mode, vscode.ConfigurationTarget.Global);
    await sleep(1500);

    const before = api.today();
    let source = null;
    let character = indent.length;
    let shownEarly = false;
    const ask = () => {
      source?.cancel();
      source = new vscode.CancellationTokenSource();
      const call = api.provider.provideInlineCompletionItems(document, new vscode.Position(lineIndex, character), AUTO, source.token);
      call.then((items) => {
        if (items?.length) shownEarly = true;
      });
      return call;
    };

    let last = ask();
    await sleep(HESITATION_MS);
    for (let i = 0; i < typed.length; i++) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, new vscode.Position(lineIndex, character), typed[i]);
      await vscode.workspace.applyEdit(edit);
      character++;
      last = ask();
      if (i < typed.length - 1) await sleep(/[ .(=,;:]/.test(typed[i]) ? BOUNDARY_MS : KEY_MS);
    }
    const stoppedAt = Date.now();
    const items = await Promise.race([last, sleep(GIVE_UP_MS).then(() => undefined)]);
    const latency = Date.now() - stoppedAt;
    await sleep(900);
    const after = api.today();
    source?.cancel();

    const suggestion = items?.[0]?.insertText ?? '';
    const rest = content.slice(typed.length);
    const firstLine = String(suggestion).split('\n')[0].trimEnd();
    rows.push({
      line: lineIndex + 1,
      mode,
      typed,
      latency: items?.length ? latency : null,
      onScreenWhileTyping: shownEarly && items?.length ? latency < 30 : false,
      requests: after.requests - before.requests,
      inputTokens: after.inputTokens + after.cacheReadTokens + after.cacheWriteTokens - (before.inputTokens + before.cacheReadTokens + before.cacheWriteTokens),
      exact: firstLine !== '' && firstLine === rest.trimEnd(),
      suggestion: firstLine.slice(0, 70),
      expected: rest.slice(0, 70),
    });
  }

  for (const lineIndex of pickLines(sourceLines, count)) {
    for (const mode of MODES) await typeLine(lineIndex, mode);
  }
  await setAll(original);
  await settings.update('speculation', undefined, vscode.ConfigurationTarget.Global);
  fs.writeFileSync(process.env.GHOSTLINE_E2E_RESULT, JSON.stringify({ steps: [{ name: 'simulación de tecleo', ok: true }], rows }));
  assert.ok(rows.length > 0);
}

exports.run = run;
