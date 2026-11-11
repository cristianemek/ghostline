import * as vscode from 'vscode';
import { MAX_SYMBOLS, enclosingOpener, extractSignature, formatSymbols, pickIdentifiers, type ResolvedSymbol } from './symbolText';

export interface SymbolDeps {
  /** True for paths that must never be read as context. */
  isPathExcluded(path: string): boolean;
  charsPerToken(): number;
  /** Lines around the cursor that the prompt already contains. */
  window(): { prefixLines: number; suffixLines: number };
}

/** The lookup shares the debounce window, so it must never take longer than that. */
const LOOKUP_TIMEOUT_MS = 300;
const CACHE_MS = 60_000;
const MAX_CACHE_ENTRIES = 300;
/** Lines of a definition that are read: enough for the members of a struct or an interface. */
const DEFINITION_LINES = 40;
/** How far above the cursor the call or literal being filled in is looked for. */
const OPENER_LINES = 12;

type Definition = vscode.Location | vscode.LocationLink;

function targetOf(definition: Definition): { uri: vscode.Uri; line: number } {
  if ('targetUri' in definition) {
    return { uri: definition.targetUri, line: (definition.targetSelectionRange ?? definition.targetRange).start.line };
  }
  return { uri: definition.uri, line: definition.range.start.line };
}

/**
 * Phase 3: for up to three identifiers, asks the language server where they are defined and returns
 * the declaration of each: the signature line or, for a struct, interface, object type or enum of
 * this workspace, its members too. The identifiers come from the current line and, when there is
 * room, from the line that opened the call or literal the cursor is inside of. Definitions the prompt
 * already shows, and anything in an excluded file, are skipped. It is ghostline that reads the other
 * file, never the model: the model has no tools.
 */
export function createSymbolProvider(deps: SymbolDeps) {
  const cache = new Map<string, { value: ResolvedSymbol | null; expiresAt: number }>();

  async function resolve(document: vscode.TextDocument, position: vscode.Position, name: string, at: vscode.Position): Promise<ResolvedSymbol | null> {
    const key = `${document.uri.toString()}#${name}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const definitions = await vscode.commands.executeCommand<Definition[] | undefined>(
      'vscode.executeDefinitionProvider',
      document.uri,
      at,
    );
    let value: ResolvedSymbol | null = null;
    const first = definitions?.[0];
    if (first) {
      const { uri, line } = targetOf(first);
      const { prefixLines, suffixLines } = deps.window();
      const alreadyVisible =
        uri.toString() === document.uri.toString() && line >= position.line - prefixLines && line <= position.line + suffixLines;
      if (!alreadyVisible && uri.scheme === 'file' && !deps.isPathExcluded(uri.fsPath)) {
        const target = await vscode.workspace.openTextDocument(uri);
        const lines: string[] = [];
        for (let index = line; index < Math.min(target.lineCount, line + DEFINITION_LINES); index++) lines.push(target.lineAt(index).text);
        // The members of a type only from this workspace: the standard library and the language's
        // own typings are known to the model, and are not this project's to send.
        const signature = extractSignature(lines, 0, vscode.workspace.getWorkspaceFolder(uri) !== undefined);
        if (signature) value = { path: vscode.workspace.asRelativePath(uri, false), signature };
      }
    }
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
    return value;
  }

  return async (document: vscode.TextDocument, position: vscode.Position, signal: AbortSignal): Promise<string[]> => {
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const wanted = pickIdentifiers(linePrefix).map((use) => ({ name: use.name, at: new vscode.Position(position.line, use.character) }));
    if (wanted.length < MAX_SYMBOLS) {
      // Inside a call or a literal opened further up ("…CreateParams{" and the cursor on a field
      // line): what is being filled in is named on that line, not on this one.
      const above: string[] = [];
      for (let line = Math.max(0, position.line - OPENER_LINES); line < position.line; line++) above.push(document.lineAt(line).text);
      const opener = enclosingOpener(above, linePrefix);
      if (opener) {
        const line = position.line - opener.linesUp;
        for (const use of pickIdentifiers(document.lineAt(line).text.slice(0, opener.character))) {
          if (wanted.length >= MAX_SYMBOLS) break;
          if (!wanted.some((known) => known.name === use.name)) wanted.push({ name: use.name, at: new vscode.Position(line, use.character) });
        }
      }
    }
    if (wanted.length === 0 || signal.aborted) return [];

    const lookups = Promise.all(wanted.map((identifier) => resolve(document, position, identifier.name, identifier.at).catch(() => null)));
    const timeout = new Promise<null>((done) => {
      const timer = setTimeout(() => done(null), LOOKUP_TIMEOUT_MS);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        done(null);
      }, { once: true });
    });
    const resolved = await Promise.race([lookups, timeout]);
    if (!resolved) return [];
    return formatSymbols(
      resolved.filter((symbol): symbol is ResolvedSymbol => symbol !== null),
      deps.charsPerToken(),
    );
  };
}
