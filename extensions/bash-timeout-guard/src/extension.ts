import type {
  BashToolDetails,
  BashToolInput,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 60;

const WHOLE_SECONDS_ERROR = "must be a positive whole number of seconds";

type BashTool = ReturnType<typeof createBashTool>;
type BashParameters = BashTool["parameters"];
type GuardedBashTool = ToolDefinition<BashParameters, BashToolDetails | undefined>;

type BashPromptMetadata = Pick<
  GuardedBashTool,
  "description" | "promptSnippet" | "promptGuidelines"
>;

export type BashToolFactory = (cwd: string) => BashTool;

export type BashTimeoutGuardConfig = {
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  prompt: string;
};

export type BashTimeoutGuardOptions = Partial<BashTimeoutGuardConfig> & {
  toolFactory?: BashToolFactory;
};

export const DEFAULT_OPTIONS: BashTimeoutGuardConfig = {
  defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  prompt: "",
};

const assertWholeSeconds = (name: string, value: number): number => {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} ${WHOLE_SECONDS_ERROR}`);
  }

  return value;
};

export const BashTimeoutGuardConfigSchema = z
  .object({
    defaultTimeoutSeconds: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_OPTIONS.defaultTimeoutSeconds),
    maxTimeoutSeconds: z.number().int().positive().default(DEFAULT_OPTIONS.maxTimeoutSeconds),
    prompt: z.string().default(DEFAULT_OPTIONS.prompt),
  })
  .refine(
    (config) => config.defaultTimeoutSeconds <= config.maxTimeoutSeconds,
    "defaultTimeoutSeconds must be less than or equal to maxTimeoutSeconds",
  );

const resolveConfig = (options: Partial<BashTimeoutGuardConfig> = {}): BashTimeoutGuardConfig =>
  BashTimeoutGuardConfigSchema.parse(options);

export const normalizeBashTimeout = (
  timeout: number | undefined,
  config: BashTimeoutGuardConfig = DEFAULT_OPTIONS,
): number => {
  if (timeout === undefined) {
    return config.defaultTimeoutSeconds;
  }

  return Math.min(assertWholeSeconds("bash timeout", timeout), config.maxTimeoutSeconds);
};

export const createBashPromptMetadata = (config: BashTimeoutGuardConfig): BashPromptMetadata => {
  const extraPrompt = config.prompt.trim();
  const promptGuidelines = [
    `Use bash only for short-lived, non-interactive shell commands; pi-bash-timeout-guard applies a ${config.defaultTimeoutSeconds} second default timeout when bash timeout is omitted.`,
    `Bash timeout values must be positive whole seconds and are clamped to a maximum of ${config.maxTimeoutSeconds} seconds.`,
    "Use tmux instead of bash for servers, file watchers, REPLs, interactive prompts, background jobs, or commands expected to run longer than a couple of minutes.",
  ];

  return {
    description: `Execute a short-lived bash command in the current working directory. Returns stdout and stderr. Output is truncated like Pi's built-in bash tool. If timeout is omitted, pi-bash-timeout-guard applies a ${config.defaultTimeoutSeconds} second timeout. Timeout values must be positive whole seconds and are clamped to a maximum of ${config.maxTimeoutSeconds} seconds. Use tmux for servers, watchers, REPLs, and background jobs.`,
    promptSnippet: `Execute short-lived bash commands; default timeout ${config.defaultTimeoutSeconds}s, max timeout ${config.maxTimeoutSeconds}s, whole seconds only. Use tmux for long-running/background processes.`,
    promptGuidelines: extraPrompt ? [...promptGuidelines, extraPrompt] : promptGuidelines,
  };
};

const withGuardedTimeout = (
  params: BashToolInput,
  config: BashTimeoutGuardConfig,
): BashToolInput => ({
  ...params,
  timeout: normalizeBashTimeout(params.timeout, config),
});

export const createTimeoutGuardedBashTool = (
  cwd: string,
  options: BashTimeoutGuardOptions = {},
): GuardedBashTool => {
  const config = resolveConfig(options);
  const toolFactory = options.toolFactory ?? createBashTool;
  const bashTool = toolFactory(cwd);

  return {
    ...bashTool,
    ...createBashPromptMetadata(config),
    execute: (toolCallId, params, signal, onUpdate, ctx) =>
      toolFactory(ctx.cwd).execute(
        toolCallId,
        withGuardedTimeout(params, config),
        signal,
        onUpdate,
      ),
  };
};

export const bashTimeoutGuard = (options: BashTimeoutGuardOptions = {}) => {
  return (pi: ExtensionAPI): void => {
    pi.registerTool(createTimeoutGuardedBashTool(process.cwd(), options));
  };
};
