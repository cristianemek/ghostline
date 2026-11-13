export interface CliLaunchOptions {
  model: string;
  effort: string;
  systemPromptFile: string;
}

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
    // only the cwd's settings, and the cwd is empty
    '--setting-sources', 'project',
    '--system-prompt-file', options.systemPromptFile,
  ];
}

export interface CliEnvOptions {
  promptCache: boolean;
}

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
  env.DISABLE_AUTOUPDATER = '1';
  if (options.promptCache) {
    delete env.DISABLE_PROMPT_CACHING;
    env.CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL = '5m';
  } else {
    env.DISABLE_PROMPT_CACHING = '1';
    delete env.CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL;
  }
  return env;
}

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

export function userMessageLine(content: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}
