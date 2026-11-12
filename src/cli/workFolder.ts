import * as fs from 'node:fs';
import * as path from 'node:path';

export const WORK_FOLDER_PREFIX = 'cwd-';

/**
 * Where the CLI runs.
 *
 * The CLI obeys a `.claude/settings.json` in its working folder even with every other source of
 * settings switched off: environment variables (`ANTHROPIC_BASE_URL` sends each request, and the
 * login that goes with it, to another server), hooks and key helpers (commands it runs). So it is
 * never launched in the user's project. It runs in a folder of ghostline's own, inside the editor's
 * per-user storage (not in a temp directory other accounts can write to), and only while that
 * folder is empty.
 */
export function createWorkFolder(parent: string): string {
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(parent, WORK_FOLDER_PREFIX));
}

/**
 * Called before every launch: recreates the folder if something removed it, and throws when it is
 * not a real, empty folder. Nothing is launched then.
 */
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

/** Removes working folders left behind by earlier sessions (only if empty: rmdir, never recursive). */
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
    } catch {
      // In use by another window, or not empty: leave it.
    }
  }
}
