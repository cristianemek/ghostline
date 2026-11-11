export interface CliLaunchOptions {
  model: string;
  effort: string;
  systemPromptFile: string;
}

/**
 * Arguments for a completion process. Everything that could add context, tools or side effects is
 * switched off; see docs/paso-0.md for what was measured.
 */
export function buildCliArgs(options: CliLaunchOptions): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', options.model,
    '--effort', options.effort,
    '--tools', '',
    '--safe-mode',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    // --safe-mode keeps user settings, and things like permissions.additionalDirectories are injected
    // into every request (~1.750 tokens here). The cwd is our own empty folder, so "project" loads nothing.
    '--setting-sources', 'project',
    '--system-prompt-file', options.systemPromptFile,
  ];
}

export interface CliEnvOptions {
  /** False: every prompt is unique, so cache writes (billed 2x) are never read back. */
  promptCache: boolean;
}

export function buildCliEnv(base: NodeJS.ProcessEnv, options: CliEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // Short-lived background processes must not each try to self-update.
  env.DISABLE_AUTOUPDATER = '1';
  if (options.promptCache) {
    delete env.DISABLE_PROMPT_CACHING;
  } else {
    env.DISABLE_PROMPT_CACHING = '1';
  }
  return env;
}

/** One line of `--input-format stream-json` input. */
export function userMessageLine(content: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}
