import * as vscode from 'vscode';
import { buildCliArgs, buildCliEnv } from '../cli/args';
import { CliWorker } from '../cli/worker';
import type { GhostlineConfig } from '../config';
import { isPathExcluded } from '../context/exclusions';
import type { UsageTracker } from '../usage/usageTracker';
import {
  IGNORED_FOLDERS,
  MAX_STYLE_FILES,
  SOURCE_EXTENSIONS,
  STYLE_CHARS_PER_TOKEN,
  buildStylePrompt,
  capProfile,
  cleanStyleGuide,
  extensionOf,
  pickStyleFiles,
  type StyleCandidate,
} from './styleProfile';

export type Launcher = { command: string; prefixArgs: string[] } | { error: string };

export interface StyleManagerDeps {
  context: vscode.ExtensionContext;
  getConfig(): GhostlineConfig;
  /** How to start the CLI, or why it cannot be started. */
  launcher(): Launcher;
  /** The CLI's working folder: the same empty folder the completions use. */
  cwd(): string;
  charsPerToken(): number;
  usage: UsageTracker;
  log(line: string): void;
  /** The profile changed (learned, edited or cleared). */
  onChange(): void;
}

const PROFILE_FILE = 'style-profile.md';
const MAX_CANDIDATES = 300;
const MAX_LISTED = 40;
const STYLE_TIMEOUT_MS = 60_000;

/**
 * The project's style profile: a ~200-token guide written by Claude from a handful of source files,
 * on demand. It lives as a plain file in the workspace's private storage so it can be reviewed and
 * edited, and it is sent first in every prompt (the stable block).
 */
export class StyleManager {
  private text: string | undefined;

  constructor(private readonly deps: StyleManagerDeps) {}

  /** What goes into the prompt: the saved profile, capped to its token budget. */
  get profile(): string | undefined {
    const capped = this.text ? capProfile(this.text) : '';
    return capped || undefined;
  }

  private get fileUri(): vscode.Uri | undefined {
    const storage = this.deps.context.storageUri;
    return storage ? vscode.Uri.joinPath(storage, PROFILE_FILE) : undefined;
  }

  async load(): Promise<void> {
    const uri = this.fileUri;
    if (!uri) return;
    try {
      this.text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).trim() || undefined;
    } catch {
      this.text = undefined;
    }
    this.deps.onChange();
  }

  /** The command: propose files, let the user confirm them, ask Claude, save and open the result. */
  async learn(): Promise<void> {
    if (!this.fileUri) {
      void vscode.window.showWarningMessage('ghostline: abre una carpeta para aprender el estilo del proyecto.');
      return;
    }
    const candidates = await this.findCandidates();
    if (candidates.length === 0) {
      void vscode.window.showWarningMessage('ghostline: no se encontraron archivos de código en esta carpeta.');
      return;
    }
    const active = vscode.window.activeTextEditor?.document;
    const preferredExtension = active && !active.isUntitled ? extensionOf(active.uri.path) : undefined;
    const suggested = pickStyleFiles(candidates, { preferredExtension });
    const suggestedPaths = new Set(suggested.map((candidate) => candidate.path));
    const listed = [...suggested, ...candidates.filter((candidate) => !suggestedPaths.has(candidate.path))].slice(0, MAX_LISTED);

    type FileItem = vscode.QuickPickItem & { uri: vscode.Uri };
    const items: FileItem[] = listed.map((candidate) => ({
      label: candidate.path,
      description: `${Math.max(1, Math.round(candidate.size / 1024))} KB`,
      picked: suggestedPaths.has(candidate.path),
      uri: candidate.uri,
    }));
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: `ghostline: archivos para aprender el estilo (máximo ${MAX_STYLE_FILES})`,
      placeHolder: 'Se envía a Claude el principio de cada archivo marcado (unos 6.000 tokens en total)',
    });
    if (!chosen || chosen.length === 0) return;
    if (chosen.length > MAX_STYLE_FILES) {
      void vscode.window.showInformationMessage(`ghostline: se usan solo los ${MAX_STYLE_FILES} primeros archivos marcados.`);
    }

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'ghostline: aprendiendo el estilo del proyecto…', cancellable: true },
        (_progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return this.learnFrom(
            chosen.slice(0, MAX_STYLE_FILES).map((item) => item.uri),
            controller.signal,
          );
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== 'cancelled') void vscode.window.showErrorMessage(`ghostline: no se pudo generar el perfil de estilo: ${message}`);
      return;
    }
    await this.edit();
    void vscode.window.showInformationMessage(
      'ghostline: perfil de estilo guardado. Se envía en cada petición; edítalo y guarda si quieres ajustarlo.',
    );
  }

  /** Generates and saves the profile from these files. No UI: `learn` and the tests call it. */
  async learnFrom(uris: readonly vscode.Uri[], signal?: AbortSignal): Promise<string> {
    const { deps } = this;
    const fileUri = this.fileUri;
    if (!fileUri) throw new Error('no hay carpeta abierta');
    const patterns = deps.getConfig().excludePatterns;
    const files: Array<{ path: string; content: string }> = [];
    for (const uri of uris.slice(0, MAX_STYLE_FILES)) {
      // Belt and braces: an excluded file never leaves the machine, whoever asked for it.
      if (isPathExcluded(uri.fsPath, patterns)) continue;
      const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      files.push({ path: vscode.workspace.asRelativePath(uri, false), content });
    }
    if (files.length === 0) throw new Error('ningún archivo utilizable');

    const launcher = deps.launcher();
    if ('error' in launcher) throw new Error(launcher.error);
    const config = deps.getConfig();
    const worker = new CliWorker({
      command: launcher.command,
      args: [
        ...launcher.prefixArgs,
        ...buildCliArgs({
          model: config.model,
          effort: 'low',
          systemPromptFile: deps.context.asAbsolutePath('resources/style-system-prompt.txt'),
        }),
      ],
      cwd: deps.cwd(),
      env: buildCliEnv(process.env, { promptCache: false }),
    });
    const prompt = buildStylePrompt(files, Math.min(deps.charsPerToken(), STYLE_CHARS_PER_TOKEN));
    const result = await worker.runTurn(prompt, { timeoutMs: STYLE_TIMEOUT_MS, signal });
    if (worker.alive) worker.retire();
    deps.usage.recordRequest({ status: result.status, usage: result.usage, costUsd: result.costUsd, totalMs: result.totalMs, sample: false });
    if (result.status === 'cancelled') throw new Error('cancelled');
    if (result.status !== 'ok') throw new Error(result.errorMessage ?? result.status);

    const guide = cleanStyleGuide(result.text);
    if (!guide) throw new Error('la respuesta no contenía una guía de estilo');
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, '..'));
    await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(guide + '\n'));
    this.text = guide;
    deps.log(
      `perfil de estilo generado a partir de ${files.length} archivos · entrada ${result.usage.inputTokens} tokens, ` +
        `salida ${result.usage.outputTokens} · ${Math.round(result.totalMs)} ms · ${guide.length} caracteres`,
    );
    deps.onChange();
    return guide;
  }

  /** Opens the profile in an editor. */
  async edit(): Promise<void> {
    const uri = this.fileUri;
    if (!uri || !this.text) {
      void vscode.window.showInformationMessage(
        'ghostline: todavía no hay perfil de estilo. Ejecuta «ghostline: Aprender estilo del proyecto».',
      );
      return;
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
  }

  /** Picks up edits made by hand. */
  onSaved(document: vscode.TextDocument): void {
    const uri = this.fileUri;
    if (!uri || document.uri.toString() !== uri.toString()) return;
    this.text = document.getText().trim() || undefined;
    const sent = this.profile?.length ?? 0;
    this.deps.log(
      `perfil de estilo editado: ${this.text?.length ?? 0} caracteres` +
        (this.text && sent < this.text.length ? ` (se envían los primeros ${sent})` : ''),
    );
    this.deps.onChange();
  }

  async clear(): Promise<void> {
    const uri = this.fileUri;
    this.text = undefined;
    if (uri) {
      try {
        await vscode.workspace.fs.delete(uri);
      } catch {
        // There was no profile.
      }
    }
    this.deps.onChange();
  }

  private async findCandidates(): Promise<Array<StyleCandidate & { uri: vscode.Uri }>> {
    const include = `**/*.{${SOURCE_EXTENSIONS.join(',')}}`;
    const exclude = `**/{${IGNORED_FOLDERS.join(',')}}/**`;
    const uris = await vscode.workspace.findFiles(include, exclude, MAX_CANDIDATES);
    const patterns = this.deps.getConfig().excludePatterns;
    const found = await Promise.all(
      uris
        .filter((uri) => !isPathExcluded(uri.fsPath, patterns))
        .map(async (uri) => {
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            return { uri, path: vscode.workspace.asRelativePath(uri, false), size: stat.size };
          } catch {
            return undefined;
          }
        }),
    );
    return found.filter((candidate): candidate is StyleCandidate & { uri: vscode.Uri } => candidate !== undefined);
  }
}
