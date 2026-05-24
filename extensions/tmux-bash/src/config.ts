import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { loadConfigOrDefault, templatedString } from "@richardgill/pi-config";
import { z } from "zod";

export const BACKGROUND_BASH_STATUS_KEY = "backgroundBashTmuxCommands";
export const BASH_DURATION_SEPARATOR = "\n\n";
export const SHELL_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Skip shell/tmux bookkeeping that should be owned by the new tmux window.
const DEFAULT_TMUX_ENV_EXPORT_DENYLIST = [
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TMUX",
  "TMUX_PANE",
] as const;

const DEFAULT_BASH_SYSTEM_PROMPT_SNIPPET = "Execute bash commands in background tmux windows";
const DEFAULT_TMUX_SYSTEM_PROMPT_SNIPPET =
  "Inspect and control the background tmux sessions created by bash tool";
const DEFAULT_BASH_TOOL_DESCRIPTION =
  'Execute a bash command in a background tmux window. Output is truncated to last {{bashContextLines}} lines or {{maxOutputKb}}KB. Defaults to a {{defaultTimeoutSeconds}}s timeout, max {{maxTimeoutSeconds}}s; timeoutAction defaults to "{{defaultTimeoutAction}}". Use background for long-running commands.';
const DEFAULT_TMUX_TOOL_DESCRIPTION =
  "Inspect and control background tmux windows created by bash.";

const DEFAULT_SYSTEM_PROMPT_GUIDELINES = [
  'Use {{bashToolName}} with background: true or timeoutAction: "background" for long-running commands, servers, watchers, REPLs, interactive prompts, and background bash commands.',
  "Background bash commands will report automatically when they finish; do not keep polling manually unless you need interim output.",
  "Use pollInterval only when periodic progress updates are useful or if asked to watch or poll something.",
  "Use {{tmuxToolName}} list to find background windows",
  "Use {{tmuxToolName}} peek/kill/poll/unpoll with a stable #{window_id} like @123.",
  "If asked, you can attach to tmux window using: {{attachCommand}}, where @123 is a #{window_id}.",
  "Use {{tmuxToolName}} poll/unpoll to start or stop periodic check-ins for an existing background window.",
];

const promptTemplateVariables = [
  "attachCommand",
  "bashContextLines",
  "bashToolName",
  "defaultTimeoutAction",
  "defaultTimeoutSeconds",
  "maxOutputKb",
  "maxTimeoutSeconds",
  "tmuxToolName",
];

const timeoutOrderIsValid = (config: {
  defaultTimeoutSeconds?: number;
  maxTimeoutSeconds?: number;
}): boolean =>
  config.defaultTimeoutSeconds === undefined ||
  config.maxTimeoutSeconds === undefined ||
  config.defaultTimeoutSeconds <= config.maxTimeoutSeconds;

const nonEmptyStringSchema = z.string().trim().min(1);
const positiveIntegerSchema = z.number().int().positive();

const gitRootTmuxSessionNameTemplateSchema = templatedString({
  variables: ["gitRootSessionName"],
  missing: "keep",
}).refine(
  (template) => template.includes("{{gitRootSessionName}}"),
  'gitRootTmuxSessionNameTemplate must include "{{gitRootSessionName}}" as the git root session placeholder',
);
const promptTemplateSchema = templatedString({
  variables: promptTemplateVariables,
  missing: "keep",
})
  .trim()
  .min(1);
const promptToolEntrySchema = z.union([promptTemplateSchema, z.literal(false)]);
const promptGuidelinesSchema = z.array(promptTemplateSchema);
const tmuxWindowNameTemplateSchema = templatedString({
  variables: ["command", "name", "nameOrCommand"],
  missing: "keep",
});

const buildTmuxBashOptionsSchema = () =>
  z
    .object({
      gitRootTmuxSessionNameTemplate: gitRootTmuxSessionNameTemplateSchema.default(
        "{{gitRootSessionName}}-bg",
      ),
      tmuxSessionScope: z.enum(["git-root", "global"]).default("global"),
      globalTmuxSessionName: nonEmptyStringSchema.default("pi-background"),
      tmuxWindowScope: z.enum(["pi-session", "git-root", "all"]).default("pi-session"),
      bashToolName: nonEmptyStringSchema.default("bash"),
      tmuxToolName: nonEmptyStringSchema.default("tmux"),
      bashToolDescription: promptTemplateSchema.default(DEFAULT_BASH_TOOL_DESCRIPTION),
      tmuxToolDescription: promptTemplateSchema.default(DEFAULT_TMUX_TOOL_DESCRIPTION),
      tmuxBinary: nonEmptyStringSchema.default("tmux"),
      tmuxEnvExportDenylist: z
        .array(nonEmptyStringSchema)
        .default(() => [...DEFAULT_TMUX_ENV_EXPORT_DENYLIST]),
      foregroundBashUpdateIntervalMs: positiveIntegerSchema.default(250),
      bashContextLines: positiveIntegerSchema.default(DEFAULT_MAX_LINES),
      bashCompactDisplayLines: positiveIntegerSchema.default(5),
      bashTruncatedCompactDisplayLines: positiveIntegerSchema.default(2),
      bashExpandedDisplayLines: positiveIntegerSchema.default(DEFAULT_MAX_LINES),
      completedContextLines: positiveIntegerSchema.default(20),
      completedCompactDisplayLines: positiveIntegerSchema.default(5),
      completedTruncatedCompactDisplayLines: positiveIntegerSchema.default(2),
      completedExpandedDisplayLines: positiveIntegerSchema.default(20),
      pollContextLines: positiveIntegerSchema.default(30),
      pollCompactDisplayLines: positiveIntegerSchema.default(5),
      pollTruncatedCompactDisplayLines: positiveIntegerSchema.default(2),
      pollExpandedDisplayLines: positiveIntegerSchema.default(30),
      peekContextLines: positiveIntegerSchema.default(DEFAULT_MAX_LINES),
      peekCompactDisplayLines: positiveIntegerSchema.default(5),
      peekTruncatedCompactDisplayLines: positiveIntegerSchema.default(2),
      peekExpandedDisplayLines: positiveIntegerSchema.default(DEFAULT_MAX_LINES),
      tmuxWindowNameTemplate: tmuxWindowNameTemplateSchema.default("{{nameOrCommand}}"),
      maxTmuxWindowNameLength: positiveIntegerSchema.default(30),
      autoCloseWindowsOnCompletion: z.boolean().default(true),
      alwaysShowOutputFilePath: z.boolean().default(false),
      preserveOutputFiles: z.boolean().default(true),
      outputDir: nonEmptyStringSchema.default("/tmp/pi-tmux-bash"),
      defaultTimeoutSeconds: positiveIntegerSchema.default(30),
      defaultTimeoutAction: z.enum(["kill", "background"]).default("background"),
      maxTimeoutSeconds: positiveIntegerSchema.default(60),
      defaultPollInterval: z.number().int().nonnegative().default(0),
      pollDelivery: z.enum(["model", "display"]).default("model"),
      minimumPollIntervalSeconds: positiveIntegerSchema.default(10),
      displayCommandStartMarker: z.string().default("# SHIM_END"),
      maxOutputBytes: positiveIntegerSchema.default(DEFAULT_MAX_BYTES),
      systemPrompt: z.boolean().default(true),
      bashSystemPromptSnippet: promptToolEntrySchema.default(DEFAULT_BASH_SYSTEM_PROMPT_SNIPPET),
      tmuxSystemPromptSnippet: promptToolEntrySchema.default(DEFAULT_TMUX_SYSTEM_PROMPT_SNIPPET),
      systemPromptGuidelines: promptGuidelinesSchema.default(() => [
        ...DEFAULT_SYSTEM_PROMPT_GUIDELINES,
      ]),
    })
    .refine(timeoutOrderIsValid, {
      message: "defaultTimeoutSeconds must be less than or equal to maxTimeoutSeconds",
    });

export const TmuxBashOptionsSchema = buildTmuxBashOptionsSchema();
export const TmuxBashConfigSchema = buildTmuxBashOptionsSchema();

type ParsedTmuxBashOptions = z.input<typeof TmuxBashOptionsSchema>;
type ParsedResolvedOptions = z.output<typeof TmuxBashOptionsSchema>;

export type TmuxBashOptions = Omit<ParsedTmuxBashOptions, "tmuxEnvExportDenylist"> & {
  tmuxEnvExportDenylist?: readonly string[];
};

export type ResolvedOptions = Omit<ParsedResolvedOptions, "tmuxEnvExportDenylist"> & {
  tmuxEnvExportDenylist: readonly string[];
};

export const DEFAULT_OPTIONS: ResolvedOptions = TmuxBashOptionsSchema.parse({});

export const resolveOptions = (input: TmuxBashOptions = {}): ResolvedOptions =>
  TmuxBashOptionsSchema.parse(input);

// Example:
// const options = loadTmuxBashConfig();
//
// Reads ~/.pi/agent/tmux-bash.jsonc with the same schema as the extension entrypoint.
// Falls back to DEFAULT_OPTIONS for omitted config.
// Use this when another extension wants to target the same tmux session/window scope.
export const loadTmuxBashConfig = (): ResolvedOptions =>
  resolveOptions(
    loadConfigOrDefault({
      filename: "tmux-bash.jsonc",
      schema: TmuxBashConfigSchema,
    }),
  );
