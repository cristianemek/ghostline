import * as fs from 'node:fs';
import * as path from 'node:path';

export const WORK_FOLDER_PREFIX = 'cwd-';

// claude reads .claude/settings.json from its cwd (env, hooks): it only runs in an empty folder of ours
export function createWorkFolder(parent: string): string {
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(parent, WORK_FOLDER_PREFIX));
}

export function ensureEmptyWorkFolder(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error(`la carpeta de trabajo de la CLI es un enlace (${dir}); no se lanza la CLI en ella`);
  }
  const entries = fs.readdirSync(dir);
  if (entries.length > 0) {
    throw new Error(
      `la carpeta de trabajo de la CLI debería estar vacía y contiene ${entries.slice(0, 3).join(', ')} (${dir}); no se lanza la CLI en ella`,
    );
  }
}

export function removeStaleWorkFolders(parent: string, prefix: string, current: string, olderThanMs: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return;
  }
  const limit = Date.now() - olderThanMs;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const dir = path.join(parent, name);
    if (dir === current) continue;
    try {
      if (fs.statSync(dir).mtimeMs < limit) fs.rmdirSync(dir);
    } catch {}
  }
}
