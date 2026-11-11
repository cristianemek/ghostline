import * as vscode from 'vscode';
import { extractSignature, formatSymbols, pickIdentifiers, type ResolvedSymbol } from './symbolText';

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

type Definition = vscode.Location | vscode.LocationLink;

function targetOf(definition: Definition): { uri: vscode.Uri; line: number } {
  if ('targetUri' in definition) {
    return { uri: definition.targetUri, line: (definition.targetSelectionRange ?? definition.targetRange).start.line };
  }
  return { uri: definition.uri, line: definition.range.start.line };
}

/**
 * Phase 3: for up to three identifiers on the current line, asks the language server where they are
 * defined and returns the signature line of each definition. Definitions the prompt already shows,
 * and anything in an excluded file, are skipped.
 */
export function createSymbolProvider(deps: SymbolDeps) {
  const cache = new Map<string, { value: ResolvedSymbol | null; expiresAt: number }>();

  async function resolve(document: vscode.TextDocument, position: vscode.Position, name: string, character: number): Promise<ResolvedSymbol | null> {
    const key = `${document.uri.toString()}#${name}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const definitions = await vscode.commands.executeCommand<Definition[] | undefined>(
      'vscode.executeDefinitionProvider',
      document.uri,
      new vscode.Position(position.line, character),
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
        for (let index = line; index < Math.min(target.lineCount, line + 4); index++) lines.push(target.lineAt(index).text);
        const signature = extractSignature(lines, 0);
        if (signature) value = { path: vscode.workspace.asRelativePath(uri, false), signature };
      }
    }
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(key, { value, expiresAt: Date.now() + CACHE_MS });
    return value;
  }

  return async (document: vscode.TextDocument, position: vscode.Position, signal: AbortSignal): Promise<string[]> => {
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const wanted = pickIdentifiers(linePrefix);
    if (wanted.length === 0 || signal.aborted) return [];

    const lookups = Promise.all(
      wanted.map((identifier) => resolve(document, position, identifier.name, identifier.character).catch(() => null)),
    );
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
