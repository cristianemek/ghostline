export interface CliLaunchOptions {
  model: string;
  effort: string;
  systemPromptFile: string;
}

/**
 * Arguments for a completion process. Everything that could add context, tools or side effects is
 * switched off.
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
    // --safe-mode keeps the user's settings, and some of them are injected into every request
    // (thousands of tokens). With "project" only the working folder's are read, and that folder is
    // ghostline's own and empty (see workFolder.ts): nothing is loaded.
    '--setting-sources', 'project',
    '--system-prompt-file', options.systemPromptFile,
  ];
}

export interface CliEnvOptions {
  /**
   * Whether the API prompt cache stays on. On, the system prompt (with the project index in it) is
   * read back at a tenth of the price by every later process; what is unique to each request is
   * still written to the cache by the CLI, which is why its lifetime is cut down below.
   */
  promptCache: boolean;
}

/**
 * Variables a running Claude Code session hands to its children. If the editor was started from a
 * Claude Code terminal they would make our processes behave as part of that session.
 */
const SESSION_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
];

export function buildCliEnv(base: NodeJS.ProcessEnv, options: CliEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of SESSION_VARIABLES) delete env[name];
  // Short-lived background processes must not each try to self-update.
  env.DISABLE_AUTOUPDATER = '1';
  if (options.promptCache) {
    delete env.DISABLE_PROMPT_CACHING;
    // The CLI caches each request's messages for an hour (written at 2x the input price), and a
    // completion's messages are never asked for again. Five minutes is the cheapest it offers
    // (1.25x); the system prompt keeps its own, longer lifetime.
    env.CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL = '5m';
  } else {
    env.DISABLE_PROMPT_CACHING = '1';
    delete env.CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL;
  }
  return env;
}

/**
 * The server the CLI will talk to when the environment points it away from Anthropic's, undefined
 * otherwise. Only the host is returned: the full value may carry credentials.
 */
export function endpointOverride(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.ANTHROPIC_BASE_URL?.trim();
  if (!value) return undefined;
  try {
    const { host } = new URL(value);
    if (host.toLowerCase() === 'api.anthropic.com') return undefined;
    return host || 'una dirección no reconocible';
  } catch {
    return 'una dirección no reconocible';
  }
}

/** One line of `--input-format stream-json` input. */
export function userMessageLine(content: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}
