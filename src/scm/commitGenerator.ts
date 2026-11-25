import * as vscode from 'vscode';
import { buildCliArgs, buildCliEnv } from '../cli/args';
import { CliWorker } from '../cli/worker';
import type { GhostlineConfig } from '../config';
import { isPathExcluded } from '../context/exclusions';
import type { Launcher } from '../learning/styleManager';
import type { UsageTracker } from '../usage/usageTracker';
import { MAX_DIFF_CHARS, MAX_FILE_CHARS, buildCommitPrompt, cleanCommitMessage, type ChangedFile } from './commitMessage';

interface GitChange {
  uri: vscode.Uri;
  status: number;
}

interface GitRepository {
  rootUri: vscode.Uri;
  inputBox: { value: string };
  state: { indexChanges: GitChange[]; workingTreeChanges: GitChange[] };
  diffIndexWithHEAD(path: string): Promise<string>;
  diffWithHEAD(path: string): Promise<string>;
  log(options?: { maxEntries?: number }): Promise<{ message: string }[]>;
}

interface GitApi {
  repositories: GitRepository[];
}

export interface CommitDeps {
  context: vscode.ExtensionContext;
  getConfig(): GhostlineConfig;
  launcher(): Launcher;
  cwd(): string;
  usage: UsageTracker;
  log(line: string): void;
  onActivity(): void;
}

const TIMEOUT_MS = 45_000;
const MAX_FILES = 40;
const MAX_NEW_FILE_CHARS = 2_500;
const STATUS: Record<number, ChangedFile['status']> = { 0: 'modified', 1: 'added', 2: 'deleted', 3: 'renamed', 4: 'added', 5: 'modified', 6: 'deleted', 7: 'added', 9: 'added' };
const UNTRACKED = 7;

export class CommitGenerator {
  private running = false;

  constructor(private readonly deps: CommitDeps) {}

  async run(source?: { rootUri?: vscode.Uri }): Promise<void> {
    if (this.running) return;
    const repository = await this.repositoryFor(source);
    if (!repository) {
      void vscode.window.showInformationMessage('ghostline: no hay ningún repositorio de Git abierto.');
      return;
    }
    this.running = true;
    try {
      const message = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: 'ghostline: escribiendo el mensaje del commit…' },
        () => this.messageFor(repository),
      );
      if (message) repository.inputBox.value = message;
    } catch (error) {
      void vscode.window.showWarningMessage(`ghostline: no se pudo escribir el mensaje: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.running = false;
      this.deps.onActivity();
    }
  }

  private async repositoryFor(source?: { rootUri?: vscode.Uri }): Promise<GitRepository | undefined> {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
    if (!extension) return undefined;
    const api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
    const wanted = source?.rootUri?.toString();
    const changed = (repository: GitRepository): boolean => repository.state.indexChanges.length + repository.state.workingTreeChanges.length > 0;
    return api.repositories.find((repository) => repository.rootUri.toString() === wanted) ?? api.repositories.find(changed) ?? api.repositories[0];
  }

  private async messageFor(repository: GitRepository): Promise<string | undefined> {
    const staged = repository.state.indexChanges.length > 0;
    const changes = (staged ? repository.state.indexChanges : repository.state.workingTreeChanges).slice(0, MAX_FILES);
    if (changes.length === 0) {
      void vscode.window.showInformationMessage('ghostline: no hay cambios de los que escribir un mensaje.');
      return undefined;
    }
    const patterns = this.deps.getConfig().excludePatterns;
    const files: ChangedFile[] = [];
    let excluded = 0;
    let room = MAX_DIFF_CHARS;
    for (const change of changes) {
      if (isPathExcluded(change.uri.fsPath, patterns)) {
        excluded++;
        continue;
      }
      const path = vscode.workspace.asRelativePath(change.uri, false).replace(/\\/g, '/');
      const diff = room > 0 ? await this.diffOf(repository, change, staged) : '';
      room -= Math.min(diff.length, MAX_FILE_CHARS);
      files.push({ path, status: STATUS[change.status] ?? 'modified', diff });
    }
    if (files.length === 0) throw new Error('todos los archivos cambiados están excluidos');
    const recent = await repository
      .log({ maxEntries: 10 })
      .then((commits) => commits.map((commit) => commit.message))
      .catch(() => []);
    return this.ask({ files, excluded, recent });
  }

  private async diffOf(repository: GitRepository, change: GitChange, staged: boolean): Promise<string> {
    try {
      if (change.status === UNTRACKED) {
        const bytes = await vscode.workspace.fs.readFile(change.uri);
        if (bytes.subarray(0, 2000).includes(0)) return '';
        const text = new TextDecoder().decode(bytes.subarray(0, MAX_NEW_FILE_CHARS * 2)).slice(0, MAX_NEW_FILE_CHARS);
        return text.split('\n').map((line) => `+${line}`).join('\n');
      }
      return await (staged ? repository.diffIndexWithHEAD(change.uri.fsPath) : repository.diffWithHEAD(change.uri.fsPath));
    } catch {
      return '';
    }
  }

  async ask(input: { files: ChangedFile[]; excluded: number; recent: string[] }): Promise<string> {
    const { deps } = this;
    const launcher = deps.launcher();
    if ('error' in launcher) throw new Error(launcher.error);
    const prompt = buildCommitPrompt(input);
    const worker = new CliWorker({
      command: launcher.command,
      args: [
        ...launcher.prefixArgs,
        ...buildCliArgs({
          model: deps.getConfig().model,
          effort: 'low',
          systemPromptFile: deps.context.asAbsolutePath('resources/commit-system-prompt.txt'),
        }),
      ],
      cwd: deps.cwd(),
      env: buildCliEnv(process.env, { promptCache: false }),
    });
    const result = await worker.runTurn(prompt.text, { timeoutMs: TIMEOUT_MS });
    if (worker.alive) worker.retire();
    deps.usage.recordRequest({ status: result.status, usage: result.usage, costUsd: result.costUsd, totalMs: result.totalMs, sample: false });
    if (result.status !== 'ok') throw new Error(result.errorMessage ?? result.status);
    const message = cleanCommitMessage(result.text);
    deps.log(
      `mensaje de commit · ${prompt.shown} archivos con diff, ${prompt.listed} solo por nombre, ${input.excluded} excluidos · ` +
        `entrada ${result.usage.inputTokens} tokens, salida ${result.usage.outputTokens} · ${Math.round(result.totalMs)} ms`,
    );
    if (!message) throw new Error('la respuesta no contenía un mensaje');
    return message;
  }
}
