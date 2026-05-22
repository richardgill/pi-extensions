import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";

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

export type TmuxBashOptions = {
  gitRootTmuxSessionNameTemplate?: string;
  tmuxSessionScope?: "git-root" | "global";
  globalTmuxSessionName?: string;
  tmuxWindowScope?: "pi-session" | "git-root" | "all";
  bashToolName?: string;
  tmuxToolName?: string;
  bashToolDescription?: string;
  tmuxToolDescription?: string;
  tmuxBinary?: string;
  tmuxEnvExportDenylist?: readonly string[];
  foregroundBashUpdateIntervalMs?: number;
  bashContextLines?: number;
  bashCompactDisplayLines?: number;
  bashTruncatedCompactDisplayLines?: number;
  bashExpandedDisplayLines?: number;
  completedContextLines?: number;
  completedCompactDisplayLines?: number;
  completedTruncatedCompactDisplayLines?: number;
  completedExpandedDisplayLines?: number;
  pollContextLines?: number;
  pollCompactDisplayLines?: number;
  pollTruncatedCompactDisplayLines?: number;
  pollExpandedDisplayLines?: number;
  peekContextLines?: number;
  peekCompactDisplayLines?: number;
  peekTruncatedCompactDisplayLines?: number;
  peekExpandedDisplayLines?: number;
  windowNameTemplate?: string;
  maxWindowNameLength?: number;
  autoCloseWindowsOnCompletion?: boolean;
  alwaysShowOutputFilePath?: boolean;
  preserveOutputFiles?: boolean;
  outputDir?: string;
  defaultTimeoutSeconds?: number;
  maxTimeoutSeconds?: number;
  defaultPollInterval?: number;
  pollDelivery?: "model" | "display";
  minimumPollIntervalSeconds?: number;
  displayCommandStartMarker?: string;
  maxOutputBytes?: number;
  systemPrompt?: boolean;
  systemPromptToolSnippets?: Record<string, string | false>;
  systemPromptGuidelines?: string[] | false;
};

export type ResolvedOptions = Required<TmuxBashOptions>;

export const DEFAULT_BASH_SYSTEM_PROMPT_SNIPPET =
  "Execute bash commands in background tmux windows";
export const DEFAULT_TMUX_SYSTEM_PROMPT_SNIPPET =
  "Inspect and control the background tmux sessions created by bash tool";
const DEFAULT_BASH_TOOL_DESCRIPTION =
  'Execute a bash command in a background tmux window. Output is truncated to last {{bashContextLines}} lines or {{maxOutputKb}}KB. Defaults to a {{defaultTimeoutSeconds}}s timeout, max {{maxTimeoutSeconds}}s; timeoutAction defaults to "background". Use background for long-running commands.';
const DEFAULT_TMUX_TOOL_DESCRIPTION =
  "Inspect and control background tmux windows created by bash.";

const DEFAULT_SYSTEM_PROMPT_TOOL_SNIPPETS = {
  bash: DEFAULT_BASH_SYSTEM_PROMPT_SNIPPET,
  tmux: DEFAULT_TMUX_SYSTEM_PROMPT_SNIPPET,
};

const DEFAULT_SYSTEM_PROMPT_GUIDELINES = [
  'Use {{bashTool}} with background: true or timeoutAction: "background" for long-running commands, servers, watchers, REPLs, interactive prompts, and background bash commands.',
  "Background bash commands will report automatically when they finish; do not keep polling manually unless you need interim output.",
  "Use pollInterval only when periodic progress updates are useful or if asked to watch or poll something.",
  "Use {{tmuxTool}} list to find background windows",
  "Use {{tmuxTool}} peek/kill/poll/unpoll with a stable #{window_id} like @123.",
  "If asked, you can attach to tmux window using: {{attachCommand}}, where @123 is a #{window_id}.",
  "Use {{tmuxTool}} poll/unpoll to start or stop periodic check-ins for an existing background window.",
];

export const DEFAULT_OPTIONS: ResolvedOptions = {
  gitRootTmuxSessionNameTemplate: "{{gitRootSessionName}}-bg",
  tmuxSessionScope: "global",
  globalTmuxSessionName: "pi-background",
  tmuxWindowScope: "pi-session",
  bashToolName: "bash",
  tmuxToolName: "tmux",
  bashToolDescription: DEFAULT_BASH_TOOL_DESCRIPTION,
  tmuxToolDescription: DEFAULT_TMUX_TOOL_DESCRIPTION,
  tmuxBinary: "tmux",
  tmuxEnvExportDenylist: DEFAULT_TMUX_ENV_EXPORT_DENYLIST,
  foregroundBashUpdateIntervalMs: 250,
  bashContextLines: DEFAULT_MAX_LINES,
  bashCompactDisplayLines: 5,
  bashTruncatedCompactDisplayLines: 2,
  bashExpandedDisplayLines: DEFAULT_MAX_LINES,
  completedContextLines: 20,
  completedCompactDisplayLines: 5,
  completedTruncatedCompactDisplayLines: 2,
  completedExpandedDisplayLines: 20,
  pollContextLines: 30,
  pollCompactDisplayLines: 5,
  pollTruncatedCompactDisplayLines: 2,
  pollExpandedDisplayLines: 30,
  peekContextLines: DEFAULT_MAX_LINES,
  peekCompactDisplayLines: 5,
  peekTruncatedCompactDisplayLines: 2,
  peekExpandedDisplayLines: DEFAULT_MAX_LINES,
  windowNameTemplate: "{{nameOrCommand}}",
  maxWindowNameLength: 30,
  autoCloseWindowsOnCompletion: true,
  alwaysShowOutputFilePath: false,
  preserveOutputFiles: true,
  outputDir: "/tmp/pi-tmux-bash",
  defaultTimeoutSeconds: 30,
  maxTimeoutSeconds: 60,
  defaultPollInterval: 0,
  pollDelivery: "model",
  minimumPollIntervalSeconds: 10,
  displayCommandStartMarker: "# SHIM_END",
  maxOutputBytes: DEFAULT_MAX_BYTES,
  systemPrompt: true,
  systemPromptToolSnippets: DEFAULT_SYSTEM_PROMPT_TOOL_SNIPPETS,
  systemPromptGuidelines: DEFAULT_SYSTEM_PROMPT_GUIDELINES,
};

const assertGitRootTmuxSessionNameTemplate = (template: string): string => {
  if (!template.includes("{{gitRootSessionName}}")) {
    throw new Error(
      'gitRootTmuxSessionNameTemplate must include "{{gitRootSessionName}}" as the git root session placeholder',
    );
  }

  return template;
};

const positiveInteger = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};

const nonNegativeInteger = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
};

const nonEmpty = (name: string, value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  return trimmed;
};

export const resolveOptions = (input: TmuxBashOptions = {}): ResolvedOptions => {
  const defaultTimeoutSeconds = positiveInteger(
    "defaultTimeoutSeconds",
    input.defaultTimeoutSeconds ?? DEFAULT_OPTIONS.defaultTimeoutSeconds,
  );
  const maxTimeoutSeconds = positiveInteger(
    "maxTimeoutSeconds",
    input.maxTimeoutSeconds ?? DEFAULT_OPTIONS.maxTimeoutSeconds,
  );

  if (defaultTimeoutSeconds > maxTimeoutSeconds) {
    throw new Error("defaultTimeoutSeconds must be less than or equal to maxTimeoutSeconds");
  }

  return {
    gitRootTmuxSessionNameTemplate: assertGitRootTmuxSessionNameTemplate(
      input.gitRootTmuxSessionNameTemplate ?? DEFAULT_OPTIONS.gitRootTmuxSessionNameTemplate,
    ),
    tmuxSessionScope: input.tmuxSessionScope ?? DEFAULT_OPTIONS.tmuxSessionScope,
    globalTmuxSessionName: nonEmpty(
      "globalTmuxSessionName",
      input.globalTmuxSessionName ?? DEFAULT_OPTIONS.globalTmuxSessionName,
    ),
    tmuxWindowScope: input.tmuxWindowScope ?? DEFAULT_OPTIONS.tmuxWindowScope,
    bashToolName: nonEmpty("bashToolName", input.bashToolName ?? DEFAULT_OPTIONS.bashToolName),
    tmuxToolName: nonEmpty("tmuxToolName", input.tmuxToolName ?? DEFAULT_OPTIONS.tmuxToolName),
    bashToolDescription: nonEmpty(
      "bashToolDescription",
      input.bashToolDescription ?? DEFAULT_OPTIONS.bashToolDescription,
    ),
    tmuxToolDescription: nonEmpty(
      "tmuxToolDescription",
      input.tmuxToolDescription ?? DEFAULT_OPTIONS.tmuxToolDescription,
    ),
    tmuxBinary: nonEmpty("tmuxBinary", input.tmuxBinary ?? DEFAULT_OPTIONS.tmuxBinary),
    tmuxEnvExportDenylist: input.tmuxEnvExportDenylist ?? DEFAULT_OPTIONS.tmuxEnvExportDenylist,
    foregroundBashUpdateIntervalMs: positiveInteger(
      "foregroundBashUpdateIntervalMs",
      input.foregroundBashUpdateIntervalMs ?? DEFAULT_OPTIONS.foregroundBashUpdateIntervalMs,
    ),
    bashContextLines: positiveInteger(
      "bashContextLines",
      input.bashContextLines ?? DEFAULT_OPTIONS.bashContextLines,
    ),
    bashCompactDisplayLines: positiveInteger(
      "bashCompactDisplayLines",
      input.bashCompactDisplayLines ?? DEFAULT_OPTIONS.bashCompactDisplayLines,
    ),
    bashTruncatedCompactDisplayLines: positiveInteger(
      "bashTruncatedCompactDisplayLines",
      input.bashTruncatedCompactDisplayLines ?? DEFAULT_OPTIONS.bashTruncatedCompactDisplayLines,
    ),
    bashExpandedDisplayLines: positiveInteger(
      "bashExpandedDisplayLines",
      input.bashExpandedDisplayLines ?? DEFAULT_OPTIONS.bashExpandedDisplayLines,
    ),
    completedContextLines: positiveInteger(
      "completedContextLines",
      input.completedContextLines ?? DEFAULT_OPTIONS.completedContextLines,
    ),
    completedCompactDisplayLines: positiveInteger(
      "completedCompactDisplayLines",
      input.completedCompactDisplayLines ?? DEFAULT_OPTIONS.completedCompactDisplayLines,
    ),
    completedTruncatedCompactDisplayLines: positiveInteger(
      "completedTruncatedCompactDisplayLines",
      input.completedTruncatedCompactDisplayLines ??
        DEFAULT_OPTIONS.completedTruncatedCompactDisplayLines,
    ),
    completedExpandedDisplayLines: positiveInteger(
      "completedExpandedDisplayLines",
      input.completedExpandedDisplayLines ?? DEFAULT_OPTIONS.completedExpandedDisplayLines,
    ),
    pollContextLines: positiveInteger(
      "pollContextLines",
      input.pollContextLines ?? DEFAULT_OPTIONS.pollContextLines,
    ),
    pollCompactDisplayLines: positiveInteger(
      "pollCompactDisplayLines",
      input.pollCompactDisplayLines ?? DEFAULT_OPTIONS.pollCompactDisplayLines,
    ),
    pollTruncatedCompactDisplayLines: positiveInteger(
      "pollTruncatedCompactDisplayLines",
      input.pollTruncatedCompactDisplayLines ?? DEFAULT_OPTIONS.pollTruncatedCompactDisplayLines,
    ),
    pollExpandedDisplayLines: positiveInteger(
      "pollExpandedDisplayLines",
      input.pollExpandedDisplayLines ?? DEFAULT_OPTIONS.pollExpandedDisplayLines,
    ),
    peekContextLines: positiveInteger(
      "peekContextLines",
      input.peekContextLines ?? DEFAULT_OPTIONS.peekContextLines,
    ),
    peekCompactDisplayLines: positiveInteger(
      "peekCompactDisplayLines",
      input.peekCompactDisplayLines ?? DEFAULT_OPTIONS.peekCompactDisplayLines,
    ),
    peekTruncatedCompactDisplayLines: positiveInteger(
      "peekTruncatedCompactDisplayLines",
      input.peekTruncatedCompactDisplayLines ?? DEFAULT_OPTIONS.peekTruncatedCompactDisplayLines,
    ),
    peekExpandedDisplayLines: positiveInteger(
      "peekExpandedDisplayLines",
      input.peekExpandedDisplayLines ?? DEFAULT_OPTIONS.peekExpandedDisplayLines,
    ),
    windowNameTemplate: input.windowNameTemplate ?? DEFAULT_OPTIONS.windowNameTemplate,
    maxWindowNameLength: positiveInteger(
      "maxWindowNameLength",
      input.maxWindowNameLength ?? DEFAULT_OPTIONS.maxWindowNameLength,
    ),
    autoCloseWindowsOnCompletion:
      input.autoCloseWindowsOnCompletion ?? DEFAULT_OPTIONS.autoCloseWindowsOnCompletion,
    alwaysShowOutputFilePath:
      input.alwaysShowOutputFilePath ?? DEFAULT_OPTIONS.alwaysShowOutputFilePath,
    preserveOutputFiles: input.preserveOutputFiles ?? DEFAULT_OPTIONS.preserveOutputFiles,
    outputDir: nonEmpty("outputDir", input.outputDir ?? DEFAULT_OPTIONS.outputDir),
    defaultTimeoutSeconds,
    maxTimeoutSeconds,
    defaultPollInterval: nonNegativeInteger(
      "defaultPollInterval",
      input.defaultPollInterval ?? DEFAULT_OPTIONS.defaultPollInterval,
    ),
    pollDelivery: input.pollDelivery ?? DEFAULT_OPTIONS.pollDelivery,
    minimumPollIntervalSeconds: positiveInteger(
      "minimumPollIntervalSeconds",
      input.minimumPollIntervalSeconds ?? DEFAULT_OPTIONS.minimumPollIntervalSeconds,
    ),
    displayCommandStartMarker:
      input.displayCommandStartMarker ?? DEFAULT_OPTIONS.displayCommandStartMarker,
    maxOutputBytes: positiveInteger(
      "maxOutputBytes",
      input.maxOutputBytes ?? DEFAULT_OPTIONS.maxOutputBytes,
    ),
    systemPrompt: input.systemPrompt ?? DEFAULT_OPTIONS.systemPrompt,
    systemPromptToolSnippets: {
      ...DEFAULT_OPTIONS.systemPromptToolSnippets,
      ...input.systemPromptToolSnippets,
    },
    systemPromptGuidelines: input.systemPromptGuidelines ?? DEFAULT_OPTIONS.systemPromptGuidelines,
  };
};
