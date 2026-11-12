import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { INDEXED_EXTENSIONS, buildProjectIndex, declarationsOf, isIndexable, type IndexedFile, type ProjectIndex } from './projectIndex';

export interface IndexerDeps {
  /** True for paths that must never be read as context. */
  isPathExcluded(path: string): boolean;
}

const INCLUDE = `**/*.{${INDEXED_EXTENSIONS.join(',')}}`;
/** Dependencies, build output and tests: none of it is the project's own API. */
const EXCLUDE =
  '{**/node_modules/**,**/vendor/**,**/dist/**,**/build/**,**/out/**,**/target/**,**/.git/**,**/.venv/**,**/venv/**,' +
  '**/__pycache__/**,**/coverage/**,**/.next/**,**/*.min.js,**/*_test.go,**/*.test.*,**/*.spec.*,**/test/**,**/tests/**,**/__tests__/**}';
const MAX_FILES = 400;
const MAX_FILE_BYTES = 300_000;
/** Everything read in one scan, at most. */
const MAX_TOTAL_BYTES = 20_000_000;
const FILES_AT_ONCE = 16;
/**
 * Size of the index in the system prompt: about 5.000 tokens. Fixed in characters, not tokens, so
 * that what fits does not shift as the token estimate adjusts (the prompt cache needs the same text).
 */
export const MAX_INDEX_CHARS = 14_000;

/**
 * Keeps the declarations of the workspace's source files (see projectIndex.ts): everything once at
 * start, then a file at a time as files are saved, created or deleted. It reads files itself, through
 * the editor's file system and behind ghostline's exclusions; the model never reads anything.
 */
export class ProjectIndexer {
  private readonly files = new Map<string, IndexedFile>();
  private scanning: Promise<void> | undefined;
  private scanned = false;

  constructor(private readonly deps: IndexerDeps) {}

  get ready(): boolean {
    return this.scanned;
  }

  /** Reads every indexable file of the workspace. Calls made while one is running share it. */
  scan(): Promise<void> {
    this.scanning ??= this.scanAll().finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }

  /** A file was saved or created: read it again. True when what it declares has changed. */
  async update(uri: vscode.Uri): Promise<boolean> {
    const key = uri.toString();
    const before = this.files.get(key)?.declarations ?? [];
    const file = (await this.read(uri))?.file;
    if (file) this.files.set(key, file);
    else this.files.delete(key);
    const after = file?.declarations ?? [];
    return before.length !== after.length || before.some((line, index) => line !== after[index]);
  }

  /** True when the file was in the index. */
  remove(uri: vscode.Uri): boolean {
    return this.files.delete(uri.toString());
  }

  index(active: vscode.Uri | undefined): ProjectIndex {
    const activePath = active && vscode.workspace.getWorkspaceFolder(active) ? relativePath(active) : undefined;
    return buildProjectIndex([...this.files.values()], activePath, MAX_INDEX_CHARS);
  }

  private async scanAll(): Promise<void> {
    const uris = await vscode.workspace.findFiles(INCLUDE, EXCLUDE, MAX_FILES);
    const found = new Map<string, IndexedFile>();
    let bytes = 0;
    // A few at a time, and not past a total: a huge repository must not be read whole into memory.
    for (let start = 0; start < uris.length && bytes < MAX_TOTAL_BYTES; start += FILES_AT_ONCE) {
      const batch = await Promise.all(uris.slice(start, start + FILES_AT_ONCE).map(async (uri) => [uri, await this.read(uri)] as const));
      for (const [uri, read] of batch) {
        if (!read) continue;
        bytes += read.bytes;
        found.set(uri.toString(), read.file);
      }
    }
    this.files.clear();
    for (const [key, file] of found) this.files.set(key, file);
    this.scanned = true;
  }

  private async read(uri: vscode.Uri): Promise<{ file: IndexedFile; bytes: number } | undefined> {
    if (uri.scheme !== 'file' || !isIndexable(uri.fsPath) || this.deps.isPathExcluded(uri.fsPath)) return undefined;
    try {
      const real = await insideWorkspace(uri);
      // The exclusions hold for where the file really is, too.
      if (!real || this.deps.isPathExcluded(real)) return undefined;
      const { size } = await vscode.workspace.fs.stat(uri);
      if (size > MAX_FILE_BYTES) return undefined;
      const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
      const relative = relativePath(uri);
      return { file: { path: relative, declarations: declarationsOf(text, relative) }, bytes: size };
    } catch {
      // Deleted in the meantime, unreadable…: it is simply not in the index.
      return undefined;
    }
  }
}

function relativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

/**
 * The file's real location when it is inside its workspace folder, undefined otherwise. A symbolic
 * link in a repository can point anywhere on the disk; what is behind it is not part of the project
 * and is never read.
 */
async function insideWorkspace(uri: vscode.Uri): Promise<string | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  const [real, root] = await Promise.all([realpath(uri.fsPath), realpath(folder.uri.fsPath)]);
  const relative = path.relative(root, real);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) ? real : undefined;
}
