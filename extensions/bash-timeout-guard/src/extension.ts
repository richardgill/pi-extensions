import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  BashToolDetails,
  BashToolInput,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { createBashTool } from "@mariozechner/pi-coding-agent";

export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 60;

export type BashTimeoutGuardConfig = {
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  prompt: string;
};

export const DEFAULT_OPTIONS: BashTimeoutGuardConfig = {
  defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  prompt: "",
};

export const createBashToolDescription = (config: BashTimeoutGuardConfig): string =>
  `Execute a short-lived bash command in the current working directory. Returns stdout and stderr. Output is truncated like Pi's built-in bash tool. If timeout is omitted, pi-bash-timeout-guard applies a ${config.defaultTimeoutSeconds} second timeout. Timeout values must be positive whole seconds and are clamped to a maximum of ${config.maxTimeoutSeconds} seconds. Use tmux for servers, watchers, REPLs, and background jobs.`;

export const createBashPromptSnippet = (config: BashTimeoutGuardConfig): string =>
  `Execute short-lived bash commands; default timeout ${config.defaultTimeoutSeconds}s, max timeout ${config.maxTimeoutSeconds}s, whole seconds only. Use tmux for long-running/background processes.`;

export const renderPromptTemplate = (template: string, config: BashTimeoutGuardConfig): string =>
  template
    .replaceAll("{{defaultTimeoutSeconds}}", String(config.defaultTimeoutSeconds))
    .replaceAll("{{maxTimeoutSeconds}}", String(config.maxTimeoutSeconds));

export const createBashPromptGuidelines = (config: BashTimeoutGuardConfig): string[] => {
  const extraPrompt = renderPromptTemplate(config.prompt, config).trim();
  return [
    `Use bash only for short-lived, non-interactive shell commands; pi-bash-timeout-guard applies a ${config.defaultTimeoutSeconds} second default timeout when bash timeout is omitted.`,
    `Bash timeout values must be positive whole seconds and are clamped to a maximum of ${config.maxTimeoutSeconds} seconds.`,
    "Use tmux instead of bash for servers, file watchers, REPLs, interactive prompts, background jobs, or commands expected to run longer than a couple of minutes.",
    ...(extraPrompt ? [extraPrompt] : []),
  ];
};

type BashTool = ReturnType<typeof createBashTool>;
type BashParameters = BashTool["parameters"];
type GuardedBashTool = ToolDefinition<BashParameters, BashToolDetails | undefined>;

export type BashToolFactory = (cwd: string) => BashTool;

export type BashTimeoutGuardOptions = Partial<BashTimeoutGuardConfig> & {
  toolFactory?: BashToolFactory;
};

const resolveConfig = (options: Partial<BashTimeoutGuardConfig> = {}): BashTimeoutGuardConfig => {
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_OPTIONS.maxTimeoutSeconds;
  const defaultTimeoutSeconds = Math.min(
    options.defaultTimeoutSeconds ?? DEFAULT_OPTIONS.defaultTimeoutSeconds,
    maxTimeoutSeconds,
  );
  const prompt = options.prompt ?? DEFAULT_OPTIONS.prompt;
  return { defaultTimeoutSeconds, maxTimeoutSeconds, prompt };
};

export const normalizeBashTimeout = (
  timeout: number | undefined,
  config: BashTimeoutGuardConfig = DEFAULT_OPTIONS,
): number => {
  if (timeout === undefined) {
    return config.defaultTimeoutSeconds;
  }

  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout <= 0) {
    throw new Error("bash timeout must be a positive whole number of seconds");
  }

  return Math.min(timeout, config.maxTimeoutSeconds);
};

const buildGuardedBashParams = (
  params: BashToolInput,
  config: BashTimeoutGuardConfig,
): BashToolInput => ({
  ...params,
  timeout: normalizeBashTimeout(params.timeout, config),
});

const executeGuardedBash = async (
  toolFactory: BashToolFactory,
  config: BashTimeoutGuardConfig,
  toolCallId: string,
  params: BashToolInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
  ctx: ExtensionContext,
): Promise<AgentToolResult<BashToolDetails | undefined>> => {
  const bashTool = toolFactory(ctx.cwd);
  return bashTool.execute(toolCallId, buildGuardedBashParams(params, config), signal, onUpdate);
};

export const createTimeoutGuardedBashTool = (
  cwd: string,
  options: BashTimeoutGuardOptions = {},
): GuardedBashTool => {
  const config = resolveConfig(options);
  const toolFactory = options.toolFactory ?? createBashTool;
  const bashTool = toolFactory(cwd);

  return {
    ...bashTool,
    description: createBashToolDescription(config),
    promptSnippet: createBashPromptSnippet(config),
    promptGuidelines: createBashPromptGuidelines(config),
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      executeGuardedBash(toolFactory, config, toolCallId, params, signal, onUpdate, ctx),
  };
};

export const bashTimeoutGuard = (options: BashTimeoutGuardOptions = {}) => {
  return (pi: ExtensionAPI): void => {
    pi.registerTool(createTimeoutGuardedBashTool(process.cwd(), options));
  };
};
