import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type AgentToolUpdateCallback,
  type BashToolDetails,
  type ExtensionAPI,
  type ExtensionContext,
  type TruncationOptions,
  type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { sleep } from "@richardgill/lib";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  backgroundSessionName,
  DEFAULT_SESSION_NAME_TEMPLATE,
  exec,
  execSafe,
  formatWindowLines,
  getGitRoot,
  getWindows,
  shellQuote,
  sessionExists,
  tmuxWindowAttachCommand,
  tmuxWindowAttachHint,
  type TmuxWindow,
  type TmuxWindowFilters,
} from "./tmux-utils.js";
import {
  buildBashToolCallSchema,
  buildTmuxToolCallSchema,
  type BashInput,
  type TmuxInput,
} from "./tool-call-schemas.js";

const SIGNAL_BASE = "/tmp/pi-tmux-bash";
const SHARED_SESSION_NAME = "pi-background";
const BACKGROUND_BASH_STATUS_KEY = "backgroundBashTmuxCommands";
const FOREGROUND_BASH_UPDATE_INTERVAL_MS = 250;
const BASH_DURATION_SEPARATOR = "\n\n";
const SHELL_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TMUX_ENV_EXPORT_DENYLIST = new Set(["PWD", "OLDPWD", "SHLVL", "_", "TMUX", "TMUX_PANE"]);

export type TmuxBashOptions = {
  gitRootTmuxSessionNameTemplate?: string;
  tmuxSessionScope?: "git-root" | "global";
  globalTmuxSessionName?: string;
  tmuxWindowScope?: "pi-session" | "git-root" | "all";
  bashToolName?: string;
  tmuxToolName?: string;
  tmuxBinary?: string;
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
  displayCommandStartMarker?: string;
  maxOutputBytes?: number;
  systemPrompt?: boolean;
  systemPromptAvailableTools?: Record<string, string | false>;
  systemPromptGuidelines?: string[] | false;
};

type RenderTheme = {
  fg: (name: "toolTitle" | "toolOutput" | "muted" | "dim" | "warning", text: string) => string;
  bold: (text: string) => string;
};

type TmuxToolRenderTheme = {
  fg: (name: "success" | "dim", text: string) => string;
};

type ToolRenderContext<TState, TArgs> = {
  args: TArgs;
  state: TState;
  executionStarted: boolean;
  isError: boolean;
  invalidate: () => void;
};

export type ResolvedOptions = Required<TmuxBashOptions>;
type TmuxRenderDetails = {
  summary: string;
  expandedLines?: string[];
  collapsedLines?: string[];
  visibleLines?: string[];
  attachLines?: string[];
};
type SignalInfo = {
  session: string;
  windowId: string;
  windowIndex: number;
  id: string;
  startedAt?: number;
  outputFile?: string;
};
type Poller = {
  timer: NodeJS.Timeout;
  session: string;
  windowId: string;
  windowIndex: number;
  gitRoot: string;
  piSessionId: string;
  interval: number;
  lines: number;
  signalInfo?: SignalInfo;
};

type PollerDetails = Omit<Poller, "timer" | "signalInfo">;

type BashRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
};

type ExtensionState = {
  signalDir: string | null;
  watcher: FSWatcher | null;
  bashSignals: Set<string>;
  ownedSignals: Set<string>;
  pollers: Map<string, Poller>;
  activeSession: string | null;
  activeGitRoot: string | null;
  activePiSessionId: string | null;
  statusContext: ExtensionContext | null;
  signalStartedAt: Map<string, number>;
};

type RunWindowResult = { index: number; windowId: string; id: string; outputFile?: string };
type FormattedOutput = { text: string; details: BashToolDetails | undefined };

type CollapsedOutputParts = {
  outputLines: string[];
  truncationNotice?: string;
};

const DEFAULT_BASH_PROMPT_SNIPPET = "Execute bash commands in background tmux windows";
const DEFAULT_TMUX_PROMPT_SNIPPET =
  "Inspect and control the background tmux sessions created by bash tool";

const DEFAULT_SYSTEM_PROMPT_AVAILABLE_TOOLS = {
  "{bashTool}": DEFAULT_BASH_PROMPT_SNIPPET,
  "{tmuxTool}": DEFAULT_TMUX_PROMPT_SNIPPET,
};

const DEFAULT_SYSTEM_PROMPT_GUIDELINES = [
  'Use {bashTool} with background: true or timeoutAction: "background" for long-running commands, servers, watchers, REPLs, interactive prompts, and background bash commands.',
  "Background bash commands will report automatically when they finish; do not keep polling manually unless you need interim output.",
  "Use pollInterval only when periodic progress updates are useful or if asked to watch or poll something.",
  "Use {tmuxTool} peek/list/kill/poll/unpoll to inspect, poll, or stop bash commands that are left running in tmux.",
  "Use {tmuxTool} kill only with a stable #{window_id} like @123.",
  "If asked, you can attach to tmux window using: {attachCommand}, where @123 is a #{window_id}.",
  "Use {tmuxTool} poll/unpoll to start or stop periodic check-ins for an existing background window.",
];

export const DEFAULT_OPTIONS: ResolvedOptions = {
  gitRootTmuxSessionNameTemplate: DEFAULT_SESSION_NAME_TEMPLATE,
  tmuxSessionScope: "global",
  globalTmuxSessionName: SHARED_SESSION_NAME,
  tmuxWindowScope: "pi-session",
  bashToolName: "bash",
  tmuxToolName: "tmux",
  tmuxBinary: "tmux",
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
  outputDir: SIGNAL_BASE,
  defaultTimeoutSeconds: 30,
  maxTimeoutSeconds: 60,
  defaultPollInterval: 0,
  displayCommandStartMarker: "# SHIM_END",
  maxOutputBytes: DEFAULT_MAX_BYTES,
  systemPrompt: true,
  systemPromptAvailableTools: DEFAULT_SYSTEM_PROMPT_AVAILABLE_TOOLS,
  systemPromptGuidelines: DEFAULT_SYSTEM_PROMPT_GUIDELINES,
};

const assertGitRootTmuxSessionNameTemplate = (template: string): string => {
  if (!template.includes("{gitRootSessionName}")) {
    throw new Error(
      'gitRootTmuxSessionNameTemplate must include "{gitRootSessionName}" as the git root session placeholder',
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
    tmuxBinary: nonEmpty("tmuxBinary", input.tmuxBinary ?? DEFAULT_OPTIONS.tmuxBinary),
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
    displayCommandStartMarker:
      input.displayCommandStartMarker ?? DEFAULT_OPTIONS.displayCommandStartMarker,
    maxOutputBytes: positiveInteger(
      "maxOutputBytes",
      input.maxOutputBytes ?? DEFAULT_OPTIONS.maxOutputBytes,
    ),
    systemPrompt: input.systemPrompt ?? DEFAULT_OPTIONS.systemPrompt,
    systemPromptAvailableTools: {
      ...DEFAULT_OPTIONS.systemPromptAvailableTools,
      ...input.systemPromptAvailableTools,
    },
    systemPromptGuidelines: input.systemPromptGuidelines ?? DEFAULT_OPTIONS.systemPromptGuidelines,
  };
};

export const createState = (): ExtensionState => ({
  signalDir: null,
  watcher: null,
  bashSignals: new Set(),
  ownedSignals: new Set(),
  pollers: new Map(),
  activeSession: null,
  activeGitRoot: null,
  activePiSessionId: null,
  statusContext: null,
  signalStartedAt: new Map(),
});

const signalDirPath = (options: ResolvedOptions, id: string): string => join(options.outputDir, id);

const getSignalDir = (state: ExtensionState, options: ResolvedOptions): string => {
  if (state.signalDir) return state.signalDir;

  state.signalDir = signalDirPath(options, randomBytes(8).toString("hex"));
  mkdirSync(state.signalDir, { recursive: true, mode: 0o700 });
  chmodSync(state.signalDir, 0o700);
  return state.signalDir;
};

const resetSignalDir = (
  state: ExtensionState,
  options: ResolvedOptions,
  sessionId?: string,
): void => {
  const encodedSessionId = sessionId
    ? Buffer.from(sessionId).toString("base64url").slice(0, 24)
    : null;
  const id = encodedSessionId
    ? `${encodedSessionId}-${process.pid}-${randomBytes(4).toString("hex")}`
    : randomBytes(8).toString("hex");
  state.signalDir = signalDirPath(options, id);
  mkdirSync(state.signalDir, { recursive: true, mode: 0o700 });
  chmodSync(state.signalDir, 0o700);
};

export const displayCommandForCommand = (
  cmd: string,
  marker = DEFAULT_OPTIONS.displayCommandStartMarker,
): string => {
  if (!marker) return cmd;

  const lines = cmd.split("\n");
  const reversedMarkerIndex = [...lines].reverse().findIndex((line) => line.trim() === marker);
  if (reversedMarkerIndex === -1) return cmd;

  const markerLineIndex = lines.length - reversedMarkerIndex - 1;
  return (
    lines
      .slice(markerLineIndex + 1)
      .join("\n")
      .trimStart() || cmd
  );
};

const commandLabel = (cmd: string, name: string | undefined, options: ResolvedOptions): string =>
  name ??
  displayCommandForCommand(cmd, options.displayCommandStartMarker)
    .split(/[|;&\s]/)[0]
    ?.split("/")
    .pop() ??
  "shell";

const windowNameForCommand = (
  cmd: string,
  name: string | undefined,
  options: ResolvedOptions,
): string => {
  const displayCommand = displayCommandForCommand(cmd, options.displayCommandStartMarker);
  return options.windowNameTemplate
    .replaceAll("{{nameOrCommand}}", commandLabel(cmd, name, options))
    .replaceAll("{{name}}", name ?? "")
    .replaceAll("{{command}}", displayCommand)
    .slice(0, options.maxWindowNameLength);
};

const tmuxSessionNameForGitRoot = (gitRoot: string, options: ResolvedOptions): string =>
  options.tmuxSessionScope === "global"
    ? options.globalTmuxSessionName
    : backgroundSessionName(gitRoot, options.gitRootTmuxSessionNameTemplate);

const tmuxWindowFiltersForScope = (
  gitRoot: string,
  piSessionId: string,
  options: ResolvedOptions,
): TmuxWindowFilters => {
  if (options.tmuxWindowScope === "pi-session") return { piSessionId };
  if (options.tmuxWindowScope === "git-root") return { gitRoot };
  return {};
};

const parseSignalFilename = (filename: string): SignalInfo | null => {
  const lastDot = filename.lastIndexOf(".");
  const secondLastDot = filename.lastIndexOf(".", lastDot - 1);
  if (secondLastDot === -1) return null;

  const session = filename.slice(0, secondLastDot);
  const windowTarget = filename.slice(secondLastDot + 1, lastDot);
  const windowIndex = parseInt(windowTarget.replace(/^@/, ""));
  if (!windowTarget) return null;

  return {
    session,
    windowId: windowTarget.startsWith("@") ? windowTarget : `@${windowTarget}`,
    windowIndex: Number.isNaN(windowIndex) ? 0 : windowIndex,
    id: filename.slice(lastDot + 1),
  };
};

const trimOutput = (output: string | null, tailLines: number): string =>
  (output ?? "")
    .split("\n")
    .filter((line) => line.trim())
    .slice(-tailLines)
    .join("\n");

const lastLineBytes = (content: string): number =>
  Buffer.byteLength(content.split("\n").at(-1) ?? "", "utf-8");

const exceedsLineLimit = (content: string, maxLines: number | undefined): boolean =>
  maxLines !== undefined && content.split("\n").length > maxLines;

const fullOutputSuffix = (fullOutputPath: string | undefined): string =>
  fullOutputPath ? `. Full output: ${fullOutputPath}` : "";

const fullOutputNotice = (fullOutputPath: string): string => `[Full output: ${fullOutputPath}]`;

const shouldShowOutputPath = (options: ResolvedOptions): boolean =>
  options.alwaysShowOutputFilePath;

const truncationNotice = (
  content: string,
  truncation: TruncationResult,
  fullOutputPath: string | undefined,
): string => {
  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  const suffix = fullOutputSuffix(fullOutputPath);

  if (truncation.lastLinePartial) {
    const lineSize = formatSize(lastLineBytes(content));
    return `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lineSize})${suffix}]`;
  }

  if (truncation.truncatedBy === "lines") {
    return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${suffix}]`;
  }

  return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)${suffix}]`;
};

export const formatTmuxOutputForContext = (
  content: string,
  fullOutputPath?: string,
  emptyText = "(no output)",
  showFullOutputPath = false,
  truncationOptions: TruncationOptions = {},
): FormattedOutput => {
  const text = content.trim() || emptyText;
  const maxBytes = truncationOptions.maxBytes ?? DEFAULT_MAX_BYTES;
  const useRawSingleOversizedLine =
    content.endsWith("\n") && !text.includes("\n") && Buffer.byteLength(text, "utf-8") > maxBytes;
  const useRawLineTruncation = exceedsLineLimit(content, truncationOptions.maxLines);
  const truncationInput = useRawSingleOversizedLine || useRawLineTruncation ? content : text;
  const truncation = truncateTail(truncationInput, truncationOptions);
  if (!truncation.truncated && (!showFullOutputPath || !fullOutputPath)) {
    return { text, details: undefined };
  }

  if (!truncation.truncated && fullOutputPath) {
    return { text: `${text}\n\n${fullOutputNotice(fullOutputPath)}`, details: { fullOutputPath } };
  }

  return {
    text: `${truncation.content || emptyText}\n\n${truncationNotice(
      truncationInput,
      truncation,
      fullOutputPath,
    )}`,
    details: { truncation, fullOutputPath },
  };
};

const formatOutput = formatTmuxOutputForContext;

const outputTruncationOptions = (
  options: ResolvedOptions,
  maxLines: number,
): TruncationOptions => ({
  maxLines,
  maxBytes: options.maxOutputBytes,
});

const formatTrimmedOutput = (
  content: string,
  fullOutputPath?: string,
  showFullOutputPath = false,
  truncationOptions: TruncationOptions = {},
): FormattedOutput =>
  formatOutput(content, fullOutputPath, "(no output)", showFullOutputPath, truncationOptions);

export const limitOutputLines = (content: string, lines: number): string => {
  const trimmed = content.trimEnd();
  if (!trimmed) return "";

  return trimmed.split("\n").slice(-lines).join("\n");
};

export const formatCompletionSummary = (exitCode: number): string =>
  exitCode === 0 ? "Background bash finished" : "Background bash failed";

const isFullOutputNoticeLine = (line: string): boolean => /^\[Full output: .+\]$/.test(line.trim());

const isTruncationNoticeLine = (line: string): boolean =>
  /^\[Showing .+\. Full output: .+\]$/.test(line.trim());

const stripFullOutputNoticeBrackets = (line: string): string =>
  line.replace(/^\[(Full output: .*?)\]$/, "$1");

const indentDisplayLine = (line: string): string =>
  line.trim() ? `  ${stripFullOutputNoticeBrackets(line)}` : "";

const indentDisplayLines = (lines: string[]): string[] => lines.map(indentDisplayLine);

const truncateText = (text: string, maxLength: number): string =>
  text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;

const visibleOutputLines = (lines: string[]): string[] =>
  lines
    .filter((line) => line.trim() !== "```")
    .filter((line) => !isFullOutputNoticeLine(line))
    .filter((line) => line.trim() !== "");

const isTmuxTargetLine = (line: string): boolean => line.trimStart().startsWith("tmux: ");

const formatCompletionDetailLines = (lines: string[]): string[] =>
  visibleOutputLines(lines).filter((line) => !isTmuxTargetLine(line));

const indentCompletionDetailLines = (lines: string[]): string[] => indentDisplayLines(lines);

const bashCallCommand = (args: Partial<BashInput>): string =>
  truncateText((args.command ?? "...").replace(/\s+/g, " ").trim(), 80);

const bashBackgroundMetadata = (args: Partial<BashInput>): string => {
  const poll =
    args.pollInterval !== undefined && args.pollInterval > 0 ? `, poll ${args.pollInterval}s` : "";
  return `(background${poll})`;
};

const bashCallMetadata = (args: Partial<BashInput>): string[] => {
  if (args.background === true) return [bashBackgroundMetadata(args)];

  return [args.timeout !== undefined ? `(timeout ${args.timeout}s)` : undefined].filter(
    (item) => item !== undefined,
  );
};

export const formatRenderedBashCall = (args: Partial<BashInput>): string =>
  [`$ ${bashCallCommand(args)}`, ...bashCallMetadata(args)].join(" ");

export const renderBashCallText = (args: Partial<BashInput>, theme: RenderTheme): string =>
  `${theme.fg("toolTitle", theme.bold(`$ ${bashCallCommand(args)}`))}${bashCallMetadata(args)
    .map((item) => theme.fg("muted", ` ${item}`))
    .join("")}`;

const stripTrailingEmptyLines = (lines: string[]): string[] => {
  const reversedLastContentIndex = [...lines].reverse().findIndex((line) => line.trim() !== "");
  if (reversedLastContentIndex === -1) return [];

  return lines.slice(0, lines.length - reversedLastContentIndex);
};

const parseCollapsedOutputParts = (
  raw: string,
  hideFullOutputNotice: boolean,
): CollapsedOutputParts => {
  const lines = raw
    .split("\n")
    .filter((line) => !hideFullOutputNotice || !isFullOutputNoticeLine(line));
  const truncationIndex = lines.findIndex(isTruncationNoticeLine);
  if (truncationIndex === -1) return { outputLines: stripTrailingEmptyLines(lines) };

  return {
    outputLines: stripTrailingEmptyLines(lines.slice(0, truncationIndex)),
    truncationNotice: lines[truncationIndex],
  };
};

const collapsedElisionLine = (earlierLines: number): string =>
  `... (${earlierLines} earlier lines, ctrl+o to expand)`;

const expandedElisionLine = (earlierLines: number): string =>
  `... (${earlierLines} earlier lines omitted)`;

export const formatRenderedBashResult = (
  raw: string,
  expanded: boolean,
  compactDisplayLines = DEFAULT_OPTIONS.bashCompactDisplayLines,
  expandedDisplayLines = DEFAULT_OPTIONS.bashExpandedDisplayLines,
  truncatedCompactDisplayLines = compactDisplayLines,
): string => {
  const parts = parseCollapsedOutputParts(raw, !expanded);
  const collapsedDisplayLines = parts.truncationNotice
    ? truncatedCompactDisplayLines
    : compactDisplayLines;
  const visibleOutputLineCount = expanded ? expandedDisplayLines : collapsedDisplayLines;
  if (parts.outputLines.length <= visibleOutputLineCount) {
    return [...parts.outputLines, ...(parts.truncationNotice ? ["", parts.truncationNotice] : [])]
      .join("\n")
      .trimEnd();
  }

  const visibleOutputLines = parts.outputLines.slice(-visibleOutputLineCount);
  const earlierLines = Math.max(0, parts.outputLines.length - visibleOutputLines.length);
  const elisionLine = expanded
    ? expandedElisionLine(earlierLines)
    : collapsedElisionLine(earlierLines);
  const truncationNoticeLines = parts.truncationNotice ? ["", parts.truncationNotice] : [];
  return [elisionLine, ...visibleOutputLines, ...truncationNoticeLines].join("\n").trimEnd();
};

const isCollapsedElisionLine = (line: string): boolean =>
  /^\.\.\. \([0-9]+ earlier lines, ctrl\+o to expand\)$/.test(line);

const renderCollapsedElisionLine = (line: string, theme: RenderTheme): string => {
  const match = line.match(/^(\.\.\. \([0-9]+ earlier lines, )(ctrl\+o)( to expand\))$/);
  if (!match) return theme.fg("muted", line);

  const [, prefix = "", key = "", suffix = ""] = match;
  return theme.fg("muted", prefix) + theme.fg("dim", key) + theme.fg("muted", suffix);
};

const renderBashOutputLine = (line: string, theme: RenderTheme): string => {
  if (isCollapsedElisionLine(line)) return renderCollapsedElisionLine(line, theme);
  if (isFullOutputNoticeLine(line)) return theme.fg("warning", line);

  return theme.fg("toolOutput", line);
};

const renderBashOutputText = (output: string, theme: RenderTheme): string =>
  output
    .split("\n")
    .map((line) => renderBashOutputLine(line, theme))
    .join("\n");

const durationSeconds = (ms: number): number => Math.max(0, ms / 1000);

export const formatDurationSeconds = (ms: number): string => `${Math.floor(durationSeconds(ms))}s`;

const formatElapsedDurationSeconds = (ms: number): string => `${durationSeconds(ms).toFixed(1)}s`;

const startBashRenderTiming = (context: ToolRenderContext<BashRenderState, Partial<BashInput>>) => {
  if (!context.executionStarted || context.state.startedAt !== undefined) return;

  context.state.startedAt = Date.now();
  context.state.endedAt = undefined;
};

const updateBashResultTiming = (
  context: ToolRenderContext<BashRenderState, Partial<BashInput>>,
  isPartial: boolean,
): void => {
  if (context.state.startedAt === undefined) context.state.startedAt = Date.now();

  if (isPartial && !context.state.interval) {
    context.state.interval = setInterval(() => context.invalidate(), 1000);
  }

  if (isPartial && !context.isError) return;

  if (context.state.endedAt === undefined) context.state.endedAt = Date.now();
  if (!context.state.interval) return;

  clearInterval(context.state.interval);
  context.state.interval = undefined;
};

const bashDurationText = (state: BashRenderState, isPartial: boolean): string | undefined => {
  if (state.startedAt === undefined) return undefined;

  const label = isPartial ? "Elapsed" : "Took";
  const endTime = state.endedAt ?? Date.now();
  const duration = formatElapsedDurationSeconds(endTime - state.startedAt);
  return `${label} ${duration}`;
};

const isTimeoutBackgroundResult = (raw: string): boolean =>
  raw.includes("Still running after ") && raw.includes(" in background tmux.");

const shouldRenderBashDuration = (args: Partial<BashInput>, raw: string): boolean =>
  args.background !== true && !isTimeoutBackgroundResult(raw);

export const renderBackgroundBashResultText = (
  raw: string,
  expanded: boolean,
  theme: RenderTheme,
  options = DEFAULT_OPTIONS,
): string => {
  const output = formatRenderedBashResult(
    raw,
    expanded,
    options.bashCompactDisplayLines,
    options.bashExpandedDisplayLines,
    options.bashTruncatedCompactDisplayLines,
  );
  const renderedOutput = output ? theme.fg("toolOutput", output) : "";
  return renderedOutput ? `\n${renderedOutput}` : "";
};

export const renderBashResultText = (
  raw: string,
  expanded: boolean,
  isPartial: boolean,
  state: BashRenderState,
  theme: RenderTheme,
  options = DEFAULT_OPTIONS,
): string => {
  const output = formatRenderedBashResult(
    raw,
    expanded,
    options.bashCompactDisplayLines,
    options.bashExpandedDisplayLines,
    options.bashTruncatedCompactDisplayLines,
  );
  const duration = bashDurationText(state, isPartial);
  const renderedOutput = output ? renderBashOutputText(output, theme) : "";
  const renderedDuration = duration ? theme.fg("muted", duration) : "";

  if (!renderedOutput) return isPartial ? `\n${renderedDuration}` : renderedDuration;
  return [renderedOutput, renderedDuration].filter(Boolean).join(BASH_DURATION_SEPARATOR);
};

const bashUpdate = (text = "", details?: BashToolDetails) => ({
  content: text ? [{ type: "text" as const, text }] : [],
  details,
});

const emitForegroundBashOutputUpdate = (
  onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
  windowId: string,
  outputFile: string | undefined,
  options: ResolvedOptions,
  lastText: string | undefined,
): string | undefined => {
  if (!onUpdate) return lastText;

  const output = formatTrimmedOutput(
    commandOutputTail(windowId, options.bashContextLines, options, outputFile),
    outputFile,
    shouldShowOutputPath(options),
    outputTruncationOptions(options, options.bashContextLines),
  );
  if (output.text === "(no output)" || output.text === lastText) return lastText;

  onUpdate(bashUpdate(output.text, output.details));
  return output.text;
};

const startForegroundBashOutputUpdates = (
  onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
  windowId: string,
  outputFile: string | undefined,
  options: ResolvedOptions,
): (() => void) => {
  let lastText: string | undefined;
  const update = () => {
    lastText = emitForegroundBashOutputUpdate(onUpdate, windowId, outputFile, options, lastText);
  };
  const timer = setInterval(update, FOREGROUND_BASH_UPDATE_INTERVAL_MS);

  update();
  return () => clearInterval(timer);
};

const completionOutputLines = (lines: string[]): string[] =>
  lines.filter((line) => line.trim() !== "```");

const completionExpandedLines = (lines: string[]): string[] =>
  completionOutputLines(lines).map(stripFullOutputNoticeBrackets);

export const formatRenderedCompletionMessage = (
  raw: string,
  expanded: boolean,
  options = DEFAULT_OPTIONS,
): string => {
  const [summary = "", ...detail] = raw.split("\n");
  if (expanded) {
    const detailLines = completionExpandedLines(detail).slice(
      -options.completedExpandedDisplayLines,
    );
    return [summary, ...indentDisplayLines(detailLines)].join("\n");
  }

  const output = formatRenderedBashResult(
    completionOutputLines(detail).join("\n"),
    false,
    options.completedCompactDisplayLines,
    options.completedExpandedDisplayLines,
    options.completedTruncatedCompactDisplayLines,
  );
  const detailLines = formatCompletionDetailLines(output.split("\n"));
  if (detailLines.length === 0) return summary;

  return [summary, "", ...indentCompletionDetailLines(detailLines)].join("\n");
};

const signalFilename = ({ session, windowId, id }: SignalInfo): string =>
  `${session}.${windowId}.${id}`;

const outputFileForSignal = (signalDir: string, signalInfo: SignalInfo): string =>
  join(signalDir, `${signalFilename(signalInfo)}.out`);

const readOutputFile = (outputFile: string | undefined): string | null => {
  if (!outputFile || !existsSync(outputFile)) return null;
  return readFileSync(outputFile, "utf-8");
};

const tmuxCommand = (options: ResolvedOptions): string => shellQuote(options.tmuxBinary);

const closeWindowOnCompletion = (windowId: string, options: ResolvedOptions): void => {
  if (!options.autoCloseWindowsOnCompletion) return;
  execSafe(`${tmuxCommand(options)} kill-window -t ${shellQuote(windowId)}`);
};

const tagWindowGitRoot = (windowId: string, gitRoot: string, options: ResolvedOptions): void => {
  execSafe(
    `${tmuxCommand(options)} set-window-option -q -t ${shellQuote(windowId)} @pi-tmux-bash-git-root ${shellQuote(gitRoot)}`,
  );
};

const tagWindowPiSession = (
  windowId: string,
  piSessionId: string,
  options: ResolvedOptions,
): void => {
  execSafe(
    `${tmuxCommand(options)} set-window-option -q -t ${shellQuote(windowId)} @pi-tmux-bash-pi-session-id ${shellQuote(piSessionId)}`,
  );
};

const tagWindowStartedAt = (
  windowId: string,
  options: ResolvedOptions,
  startedAt = Math.floor(Date.now() / 1000),
): void => {
  execSafe(
    `${tmuxCommand(options)} set-window-option -q -t ${shellQuote(windowId)} @pi-tmux-bash-started-at ${shellQuote(String(startedAt))}`,
  );
};

const tagWindowOutputFile = (
  windowId: string,
  outputFile: string,
  options: ResolvedOptions,
): void => {
  execSafe(
    `${tmuxCommand(options)} set-window-option -q -t ${shellQuote(windowId)} @pi-tmux-bash-output-file ${shellQuote(outputFile)}`,
  );
};

const tagWindowDisplayCommand = (
  windowId: string,
  displayCommand: string,
  options: ResolvedOptions,
): void => {
  execSafe(
    `${tmuxCommand(options)} set-window-option -q -t ${shellQuote(windowId)} @pi-tmux-bash-display-command ${shellQuote(displayCommand)}`,
  );
};

const isExportableEnvironmentName = (name: string): boolean =>
  SHELL_IDENTIFIER_REGEX.test(name) && !TMUX_ENV_EXPORT_DENYLIST.has(name);

export const formatEnvironmentExportsForBash = (env: NodeJS.ProcessEnv = process.env): string =>
  Object.entries(env)
    .filter(([name, value]) => value !== undefined && isExportableEnvironmentName(name))
    .map(([name, value]) => `export ${name}=${shellQuote(value ?? "")}`)
    .join("\n");

const createBashCommandScript = (
  signalDir: string,
  session: string,
  cmd: string,
  displayCommand: string,
  options: ResolvedOptions,
): { id: string; scriptPath: string } => {
  const scriptDir = join(signalDir, "s");
  mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
  chmodSync(scriptDir, 0o700);

  const id = randomBytes(4).toString("hex");
  const scriptPath = join(scriptDir, `${session}.${id}.sh`);
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
__signal_dir=${shellQuote(signalDir)}
__session=${shellQuote(session)}
__id=${shellQuote(id)}
__tmux_binary=${shellQuote(options.tmuxBinary)}
__window_id=$("$__tmux_binary" display-message -p -t "\${TMUX_PANE:-}" '#{window_id}' 2>/dev/null || printf '@0')
__signal_file="$__signal_dir/$__session.$__window_id.$__id"
__output_file="$__signal_file.out"
: > "$__output_file"
printf '$ %s\n' ${shellQuote(displayCommand)}
${formatEnvironmentExportsForBash()}
(
${cmd}
) 2>&1 | tee -a "$__output_file"
__rc=\${PIPESTATUS[0]}
printf '%s\n' "$__rc" > "$__signal_file"
if [ -n "\${SHELL:-}" ] && [ -x "\${SHELL:-}" ]; then
  exec "$SHELL" -l
fi
exec bash -l
`,
    { mode: 0o755 },
  );

  return { id, scriptPath };
};

const parseNewWindowResult = (raw: string): { windowId: string; index: number } => {
  const [windowId = "", index = "0"] = raw.split("|||");
  return { windowId, index: parseInt(index) };
};

const tagBashWindow = (
  signalDir: string,
  session: string,
  gitRoot: string,
  piSessionId: string,
  displayCommand: string,
  scriptId: string,
  windowId: string,
  index: number,
  options: ResolvedOptions,
): RunWindowResult => {
  const outputFile = outputFileForSignal(signalDir, {
    session,
    windowId,
    windowIndex: index,
    id: scriptId,
  });
  tagWindowGitRoot(windowId, gitRoot, options);
  tagWindowPiSession(windowId, piSessionId, options);
  tagWindowStartedAt(windowId, options);
  tagWindowOutputFile(windowId, outputFile, options);
  tagWindowDisplayCommand(windowId, displayCommand, options);

  return { index, windowId, id: scriptId, outputFile };
};

const addBashWindow = (
  signalDir: string,
  session: string,
  gitRoot: string,
  piSessionId: string,
  cmd: string,
  name: string | undefined,
  options: ResolvedOptions,
): RunWindowResult => {
  const displayCommand = displayCommandForCommand(cmd, options.displayCommandStartMarker);
  const script = createBashCommandScript(signalDir, session, cmd, displayCommand, options);
  const raw = exec(
    `${tmuxCommand(options)} new-window -d -t ${shellQuote(session)} -n ${shellQuote(windowNameForCommand(cmd, name, options))} -c ${shellQuote(gitRoot)} -P -F '#{window_id}|||#{window_index}' ${shellQuote(script.scriptPath)}`,
  );
  const { windowId, index } = parseNewWindowResult(raw);
  return tagBashWindow(
    signalDir,
    session,
    gitRoot,
    piSessionId,
    displayCommand,
    script.id,
    windowId,
    index,
    options,
  );
};

const createBashSessionWindow = (
  signalDir: string,
  session: string,
  gitRoot: string,
  piSessionId: string,
  cmd: string,
  name: string | undefined,
  options: ResolvedOptions,
): RunWindowResult => {
  const displayCommand = displayCommandForCommand(cmd, options.displayCommandStartMarker);
  const script = createBashCommandScript(signalDir, session, cmd, displayCommand, options);
  const raw = exec(
    `${tmuxCommand(options)} new-session -d -s ${shellQuote(session)} -n ${shellQuote(windowNameForCommand(cmd, name, options))} -c ${shellQuote(gitRoot)} -P -F '#{window_id}|||#{window_index}' ${shellQuote(script.scriptPath)}`,
  );
  const { windowId, index } = parseNewWindowResult(raw);
  return tagBashWindow(
    signalDir,
    session,
    gitRoot,
    piSessionId,
    displayCommand,
    script.id,
    windowId,
    index,
    options,
  );
};

const resolveWindowIndex = (
  window: number | string | undefined,
): number | undefined | "invalid" => {
  if (window === undefined) return undefined;
  if (window === "all") return "invalid";

  const index = typeof window === "number" ? window : parseInt(window);
  return Number.isNaN(index) ? "invalid" : index;
};

const waitForExitCode = async (
  signalDir: string,
  signal: AbortSignal | undefined,
  signalInfo: SignalInfo,
  timeoutSeconds: number,
): Promise<number | "timeout" | "aborted"> => {
  const signalFile = join(signalDir, signalFilename(signalInfo));
  const deadline = Date.now() + timeoutSeconds * 1000;

  for (;;) {
    if (signal?.aborted) return "aborted";
    if (existsSync(signalFile)) {
      const exitCode = parseInt(readFileSync(signalFile, "utf-8").trim());
      unlinkSync(signalFile);
      return exitCode;
    }
    if (Date.now() >= deadline) return "timeout";
    await sleep(100);
  }
};

const captureWindowOutput = (windowId: string, lines: number, options: ResolvedOptions): string =>
  execSafe(`${tmuxCommand(options)} capture-pane -t ${shellQuote(windowId)} -p -S -${lines}`) ?? "";

const commandOutputTail = (
  windowId: string,
  lines: number,
  options: ResolvedOptions,
  outputFile?: string,
): string => {
  const fileOutput = readOutputFile(outputFile);
  if (fileOutput !== null) return fileOutput;

  return captureWindowOutput(windowId, lines, options);
};

const isBashCreatedWindow = (window: TmuxWindow): boolean =>
  Boolean(window.outputFile && window.displayCommand);

const getBashCreatedWindows = (
  session: string,
  options: ResolvedOptions,
  filters: TmuxWindowFilters = {},
): TmuxWindow[] => getWindows(session, filters, options.tmuxBinary).filter(isBashCreatedWindow);

const bashWindowOutput = (window: TmuxWindow): string => readOutputFile(window.outputFile) ?? "";

const formatBashWindowOutput = (
  window: TmuxWindow,
  options: ResolvedOptions,
  contextLines: number,
): FormattedOutput =>
  formatOutput(
    bashWindowOutput(window),
    window.outputFile,
    "(no output)",
    false,
    outputTruncationOptions(options, contextLines),
  );

const bashWindowDisplayLines = (
  window: TmuxWindow,
  expanded: boolean,
  options: ResolvedOptions,
  contextLines: number,
  compactDisplayLines: number,
  expandedDisplayLines: number,
  truncatedCompactDisplayLines: number,
): string[] => [
  `$ ${window.displayCommand ?? window.title}`,
  ...formatRenderedBashResult(
    formatBashWindowOutput(window, options, contextLines).text,
    expanded,
    compactDisplayLines,
    expandedDisplayLines,
    truncatedCompactDisplayLines,
  ).split("\n"),
];

const pollerKey = (session: string, windowId: string): string => `${session}:${windowId}`;

const readSignalExitCode = (state: ExtensionState, signalInfo?: SignalInfo): number | undefined => {
  if (!signalInfo || !state.signalDir) return undefined;

  const filename = signalFilename(signalInfo);
  const signalFile = join(state.signalDir, filename);
  if (!existsSync(signalFile)) return undefined;

  const exitCode = parseInt(readFileSync(signalFile, "utf-8").trim());
  unlinkSync(signalFile);
  state.bashSignals.delete(filename);
  state.ownedSignals.delete(filename);
  state.signalStartedAt.delete(filename);
  return exitCode;
};

const stopPoller = (state: ExtensionState, session: string, windowId: string): boolean => {
  const key = pollerKey(session, windowId);
  const poller = state.pollers.get(key);
  if (!poller) return false;

  clearInterval(poller.timer);
  state.pollers.delete(key);
  return true;
};

const shellCommands = new Set(["bash", "zsh", "sh", "fish", "dash"]);

const hasChildProcesses = (pid: string): boolean =>
  Boolean(pid && execSafe(`pgrep -P ${shellQuote(pid)} | head -1`));

const isIdleShellProcess = (command: string, pid: string): boolean =>
  shellCommands.has(command) && !hasChildProcesses(pid);

const countRunningBackgroundProcesses = (
  session: string,
  filters: TmuxWindowFilters,
  options: ResolvedOptions,
): number => {
  const raw = execSafe(
    `${tmuxCommand(options)} list-windows -t ${shellQuote(session)} -F '#{pane_current_command}|||#{pane_pid}|||#{@pi-tmux-bash-git-root}|||#{@pi-tmux-bash-pi-session-id}|||#{@pi-tmux-bash-output-file}'`,
  );
  if (!raw) return 0;

  return raw
    .split("\n")
    .map((line) => {
      const [command = "", pid = "", gitRoot = "", piSessionId = "", outputFile = ""] =
        line.split("|||");
      return { command, pid, gitRoot, piSessionId, outputFile };
    })
    .filter((window) => filters.gitRoot === undefined || window.gitRoot === filters.gitRoot)
    .filter(
      (window) => filters.piSessionId === undefined || window.piSessionId === filters.piSessionId,
    )
    .filter((window) => window.outputFile)
    .filter((window) => !isIdleShellProcess(window.command, window.pid)).length;
};

const formatBackgroundProcessStatus = (count: number): string | undefined =>
  count > 0 ? `${count} background proc${count === 1 ? "" : "s"}` : undefined;

const updateBackgroundProcessStatus = (ctx: ExtensionContext, options: ResolvedOptions): void => {
  if (!ctx.hasUI) return;

  const gitRoot = getGitRoot(ctx.cwd);
  if (!gitRoot) {
    ctx.ui.setStatus(BACKGROUND_BASH_STATUS_KEY, undefined);
    return;
  }

  const session = tmuxSessionNameForGitRoot(gitRoot, options);
  const filters = tmuxWindowFiltersForScope(gitRoot, ctx.sessionManager.getSessionId(), options);
  const count = sessionExists(session, options.tmuxBinary)
    ? countRunningBackgroundProcesses(session, filters, options)
    : 0;
  ctx.ui.setStatus(BACKGROUND_BASH_STATUS_KEY, formatBackgroundProcessStatus(count));
};

const updateStoredBackgroundProcessStatus = (
  state: ExtensionState,
  options: ResolvedOptions,
): void => {
  if (!state.statusContext) return;

  try {
    updateBackgroundProcessStatus(state.statusContext, options);
  } catch {}
};

const pollerDetails = ({
  session,
  windowId,
  windowIndex,
  gitRoot,
  piSessionId,
  interval,
  lines,
}: Poller): PollerDetails => ({
  session,
  windowId,
  windowIndex,
  gitRoot,
  piSessionId,
  interval,
  lines,
});

const pollWindowLines = (window: TmuxWindow, options: ResolvedOptions): string[] => [
  `$ ${window.displayCommand ?? window.title}`,
  ...formatBashWindowOutput(window, options, options.bashContextLines).text.split("\n"),
];

const formatPollMessage = (window: TmuxWindow, options: ResolvedOptions, _lines: number): string =>
  `tmux poll: ${window.title} ${window.id}\n${indentDisplayLines(pollWindowLines(window, options)).join("\n")}\n\n  ${tmuxWindowAttachHint(window.id, process.env, options.tmuxBinary)}`;

const isAttachLine = (line: string): boolean => line.trimStart().startsWith("Attach with:");

const splitPollDetailLines = (detail: string[]): { output: string[]; attach: string[] } => {
  const attachIndex = detail.findIndex(isAttachLine);
  if (attachIndex === -1) return { output: detail, attach: [] };

  return {
    output: detail.slice(0, Math.max(0, attachIndex - 1)),
    attach: detail.slice(attachIndex - 1),
  };
};

const formatRenderedPollOutput = (
  output: string[],
  expanded: boolean,
  displayLines: number,
  options: ResolvedOptions,
): string => {
  const [command = "", ...detail] = output;
  const compacted = formatRenderedBashResult(
    detail.join("\n"),
    expanded,
    displayLines,
    displayLines,
    options.pollTruncatedCompactDisplayLines,
  );
  return [command, compacted].filter(Boolean).join("\n");
};

export const formatRenderedPollMessage = (
  raw: string,
  expanded: boolean,
  options = DEFAULT_OPTIONS,
): string => {
  const [summary = "", ...detail] = raw.split("\n");
  const displayLines = expanded
    ? options.pollExpandedDisplayLines
    : options.pollCompactDisplayLines;
  const split = splitPollDetailLines(detail);
  const output = formatRenderedPollOutput(split.output, expanded, displayLines, options);
  const rendered = [summary, output].filter(Boolean).join("\n");
  return split.attach.length > 0 ? `${rendered}\n${split.attach.join("\n")}` : rendered;
};

const startPoller = (
  pi: ExtensionAPI,
  state: ExtensionState,
  session: string,
  windowId: string,
  windowIndex: number,
  interval: number,
  lines: number,
  options: ResolvedOptions,
  gitRoot: string,
  piSessionId: string,
  signalInfo?: SignalInfo,
): void => {
  if (interval <= 0) return;

  stopPoller(state, session, windowId);
  let lastText: string | undefined;
  const timer = setInterval(() => {
    const filters = tmuxWindowFiltersForScope(gitRoot, piSessionId, options);
    const window = getBashCreatedWindows(session, options, filters).find(
      (item) => item.id === windowId,
    );
    if (!window) {
      stopPoller(state, session, windowId);
      updateStoredBackgroundProcessStatus(state, options);
      return;
    }

    const exitCode = readSignalExitCode(state, signalInfo);
    const completed = exitCode !== undefined;
    const outputFile = signalInfo?.outputFile ?? window.outputFile;
    const outputLines = completed ? options.completedContextLines : lines;
    const output = completed
      ? formatTrimmedOutput(
          commandOutputTail(windowId, outputLines, options, outputFile),
          outputFile,
          shouldShowOutputPath(options),
          outputTruncationOptions(options, outputLines),
        ).text
      : formatBashWindowOutput(window, options, outputLines).text;
    if (!completed && output === lastText) return;

    lastText = output;
    if (completed) stopPoller(state, session, windowId);

    pi.sendMessage(
      {
        customType: completed ? "tmux-bash-completion" : "tmux-bash-poll",
        content: completed
          ? `${formatCompletionSummary(exitCode)}

\`\`\`\n${output}\n\`\`\``
          : formatPollMessage(window, options, lines),
        display: true,
      },
      { triggerTurn: completed, deliverAs: "followUp" },
    );
    if (completed) {
      closeWindowOnCompletion(windowId, options);
      updateStoredBackgroundProcessStatus(state, options);
    }
  }, interval * 1000);

  state.pollers.set(pollerKey(session, windowId), {
    timer,
    session,
    windowId,
    windowIndex,
    gitRoot,
    piSessionId,
    interval,
    lines,
    signalInfo,
  });
};

const handleCompletionSignal = (
  state: ExtensionState,
  pi: ExtensionAPI,
  filepath: string,
  filename: string,
  options: ResolvedOptions,
): boolean => {
  const parsed = parseSignalFilename(filename);
  if (!parsed) return false;

  const exitCode = readFileSync(filepath, "utf-8").trim();
  if (!/^-?\d+$/.test(exitCode)) return false;
  unlinkSync(filepath);

  const outputFile = `${filepath}.out`;
  const fileOutput = readOutputFile(outputFile);
  const rawOutput =
    fileOutput ??
    execSafe(
      `${tmuxCommand(options)} capture-pane -t ${shellQuote(parsed.windowId)} -p -S -${options.completedContextLines}`,
    );
  const output = formatOutput(
    trimOutput(rawOutput, options.completedContextLines),
    fileOutput === null ? undefined : outputFile,
    "(no output)",
    shouldShowOutputPath(options),
    outputTruncationOptions(options, options.completedContextLines),
  ).text;
  const code = parseInt(exitCode);
  state.signalStartedAt.delete(filename);
  stopPoller(state, parsed.session, parsed.windowId);

  pi.sendMessage(
    {
      customType: "tmux-bash-completion",
      content: `${formatCompletionSummary(code)}\n\n\`\`\`\n${output}\n\`\`\``,
      display: true,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
  closeWindowOnCompletion(parsed.windowId, options);
  updateStoredBackgroundProcessStatus(state, options);
  return true;
};

const handleSignalFile = (
  state: ExtensionState,
  pi: ExtensionAPI,
  signalDir: string,
  filename: string,
  options: ResolvedOptions,
): void => {
  if (!state.ownedSignals.has(filename)) return;
  if (state.bashSignals.has(filename)) return;

  const filepath = join(signalDir, filename);
  if (!existsSync(filepath)) return;

  try {
    if (handleCompletionSignal(state, pi, filepath, filename, options)) {
      state.ownedSignals.delete(filename);
    }
  } catch {}
};

const startWatching = (state: ExtensionState, pi: ExtensionAPI, options: ResolvedOptions): void => {
  if (state.watcher) return;

  const signalDir = getSignalDir(state, options);
  state.watcher = watch(signalDir, (_eventType, filename) => {
    if (!filename || filename.endsWith(".sh") || filename.endsWith(".out")) return;
    setTimeout(() => handleSignalFile(state, pi, signalDir, filename.toString(), options), 100);
  });
};

const cleanupSignalDir = (signalDir: string, preserveOutputFiles: boolean): void => {
  if (!existsSync(signalDir)) return;
  if (!preserveOutputFiles) {
    rmSync(signalDir, { recursive: true, force: true });
    return;
  }

  readdirSync(signalDir, { withFileTypes: true })
    .filter((entry) => !entry.isFile() || !entry.name.endsWith(".out"))
    .forEach((entry) => rmSync(join(signalDir, entry.name), { recursive: true, force: true }));
};

const cleanupState = (state: ExtensionState, options: ResolvedOptions): void => {
  state.watcher?.close();
  state.watcher = null;
  for (const poller of state.pollers.values()) clearInterval(poller.timer);
  state.pollers.clear();
  state.bashSignals.clear();
  state.ownedSignals.clear();
  state.signalStartedAt.clear();
  state.statusContext = null;
  state.activePiSessionId = null;

  if (state.signalDir) {
    cleanupSignalDir(state.signalDir, options.preserveOutputFiles);
    state.signalDir = null;
  }
};

const toolText = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const renderedToolText = (
  text: string,
  render: TmuxRenderDetails,
  details: Record<string, unknown> = {},
) => toolText(text, { ...details, render });

const toolError = (text: string) => ({ ...toolText(text), isError: true });

const peekWindowExpandedLines = (window: TmuxWindow, options: ResolvedOptions): string[] =>
  indentDisplayLines(
    bashWindowDisplayLines(
      window,
      true,
      options,
      options.peekExpandedDisplayLines,
      options.peekCompactDisplayLines,
      options.peekExpandedDisplayLines,
      options.peekTruncatedCompactDisplayLines,
    ),
  );

const peekWindowCollapsedLines = (window: TmuxWindow, options: ResolvedOptions): string[] =>
  indentDisplayLines(
    bashWindowDisplayLines(
      window,
      false,
      options,
      options.peekContextLines,
      options.peekCompactDisplayLines,
      options.peekExpandedDisplayLines,
      options.peekTruncatedCompactDisplayLines,
    ),
  );

const renderPeekDetails = (windows: TmuxWindow[], options: ResolvedOptions): TmuxRenderDetails => {
  if (windows.length === 1) {
    const window = windows[0];
    return {
      summary: `tmux window: ${window?.title} ${window?.id}`,
      expandedLines: peekWindowExpandedLines(window, options),
      collapsedLines: peekWindowCollapsedLines(window, options),
      attachLines: [
        "",
        `  ${tmuxWindowAttachHint(window?.id ?? "", process.env, options.tmuxBinary)}`,
      ],
    };
  }

  return {
    summary: `tmux windows: ${windows.length}`,
    expandedLines: windows.flatMap((window) => [
      `  tmux window: ${window.title} ${window.id}`,
      ...peekWindowExpandedLines(window, options),
    ]),
    collapsedLines: windows.flatMap((window) => [
      `  tmux window: ${window.title} ${window.id}`,
      ...peekWindowCollapsedLines(window, options),
    ]),
    attachLines: [
      "",
      ...windows.map(
        (window) => `  ${tmuxWindowAttachHint(window.id, process.env, options.tmuxBinary)}`,
      ),
    ],
  };
};

const peekAction = (
  params: Extract<TmuxInput, { action: "peek" }>,
  session: string,
  filters: TmuxWindowFilters,
  options: ResolvedOptions,
) => {
  if (!sessionExists(session, options.tmuxBinary))
    return toolError(`No background session '${session}'.`);

  const windowIndex =
    params.window === undefined || params.window === "all"
      ? "all"
      : resolveWindowIndex(params.window);
  const target = windowIndex === "invalid" || windowIndex === undefined ? "all" : windowIndex;
  const windows = getBashCreatedWindows(session, options, filters).filter(
    (window) => target === "all" || window.index === target,
  );
  if (windows.length === 0) return toolText("No matching bash-created windows.");

  const output = windows
    .map((window) =>
      [
        `tmux window: ${window.title} ${window.id}`,
        ...bashWindowDisplayLines(
          window,
          true,
          options,
          options.peekContextLines,
          options.peekCompactDisplayLines,
          options.peekContextLines,
          options.peekTruncatedCompactDisplayLines,
        ),
      ].join("\n"),
    )
    .join("\n\n");
  const render = renderPeekDetails(windows, options);
  return renderedToolText(output, render, { session });
};

const listAction = (session: string, filters: TmuxWindowFilters, options: ResolvedOptions) => {
  if (!sessionExists(session, options.tmuxBinary))
    return toolError(`No background session '${session}'.`);

  const windows = getBashCreatedWindows(session, options, filters);
  const lines = formatWindowLines(windows);
  const summary = `Background session ${session} — ${windows.length} window(s)`;
  return renderedToolText(
    `${summary}\n\n${lines.join("\n")}`,
    { summary, visibleLines: ["", ...lines] },
    { session, windows },
  );
};

const killAction = (
  params: Extract<TmuxInput, { action: "kill" }>,
  session: string,
  filters: TmuxWindowFilters,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  if (!sessionExists(session, options.tmuxBinary))
    return toolError(`No background session '${session}'.`);
  if (!/^@\d+$/.test(params.window)) {
    return toolError("Error: kill requires a tmux #{window_id}, e.g. @123.");
  }

  const window = getBashCreatedWindows(session, options, filters).find(
    (item) => item.id === params.window,
  );
  if (!window)
    return toolError(`No bash-created tmux window ${params.window} in session ${session}.`);

  exec(`${tmuxCommand(options)} kill-window -t ${shellQuote(params.window)}`);
  stopPoller(state, session, window.id);
  return toolText(`Killed background tmux window: ${window.title} ${window.id}.`);
};

const pollAction = (
  params: Extract<TmuxInput, { action: "poll" }>,
  session: string,
  gitRoot: string,
  piSessionId: string,
  filters: TmuxWindowFilters,
  state: ExtensionState,
  pi: ExtensionAPI,
  options: ResolvedOptions,
) => {
  const windowIndex = resolveWindowIndex(params.window);
  if (windowIndex === undefined || windowIndex === "invalid") {
    return toolError("Error: 'window' (index) required for poll action.");
  }

  const window = getBashCreatedWindows(session, options, filters).find(
    (item) => item.index === windowIndex,
  );
  if (!window)
    return toolError(`No bash-created tmux window :${windowIndex} in session ${session}.`);

  if (params.pollInterval <= 0)
    return toolError("Error: pollInterval must be greater than 0 for poll action.");

  startPoller(
    pi,
    state,
    session,
    window.id,
    windowIndex,
    params.pollInterval,
    params.pollLines,
    options,
    gitRoot,
    piSessionId,
  );
  return toolText(`Polling ${window.title} every ${params.pollInterval}s.`);
};

const unpollAction = (
  params: Extract<TmuxInput, { action: "unpoll" }>,
  session: string,
  filters: TmuxWindowFilters,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const windowIndex = resolveWindowIndex(params.window);
  if (windowIndex === undefined || windowIndex === "invalid") {
    return toolError("Error: 'window' (index) required for unpoll action.");
  }

  const window = getBashCreatedWindows(session, options, filters).find(
    (item) => item.index === windowIndex,
  );
  if (!window)
    return toolError(`No bash-created tmux window :${windowIndex} in session ${session}.`);

  return toolText(
    stopPoller(state, session, window.id)
      ? `Stopped polling ${window.title}`
      : `No poller for ${window.title}.`,
  );
};

const pollerMatchesFilters = (poller: Poller, filters: TmuxWindowFilters): boolean =>
  (filters.gitRoot === undefined || poller.gitRoot === filters.gitRoot) &&
  (filters.piSessionId === undefined || poller.piSessionId === filters.piSessionId);

const listPollsAction = (
  session: string,
  filters: TmuxWindowFilters,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const pollers = [...state.pollers.values()]
    .filter((poller) => poller.session === session)
    .filter((poller) => pollerMatchesFilters(poller, filters));
  if (pollers.length === 0) return toolText("No active pollers.");

  const details = pollers.map(pollerDetails);
  const windows = getBashCreatedWindows(session, options, filters);
  const lines = details.map((poller) => {
    const title = windows.find((window) => window.id === poller.windowId)?.title ?? poller.windowId;
    return `  ${title} every ${poller.interval}s (${poller.lines} lines)`;
  });
  return renderedToolText(
    `Active pollers:\n\n${lines.join("\n")}`,
    { summary: "Active pollers:", visibleLines: ["", ...lines] },
    { pollers: details },
  );
};

const executeTool = (
  params: TmuxInput,
  ctx: ExtensionContext,
  state: ExtensionState,
  pi: ExtensionAPI,
  options: ResolvedOptions,
) => {
  const gitRoot = getGitRoot(ctx.cwd);
  if (!gitRoot) return toolError("Error: not in a git repository.");

  const piSessionId = ctx.sessionManager.getSessionId();
  const session = tmuxSessionNameForGitRoot(gitRoot, options);
  const filters = tmuxWindowFiltersForScope(gitRoot, piSessionId, options);
  if (params.action === "peek") return peekAction(params, session, filters, options);
  if (params.action === "list") return listAction(session, filters, options);
  if (params.action === "kill") {
    const result = killAction(params, session, filters, state, options);
    updateBackgroundProcessStatus(ctx, options);
    return result;
  }
  if (params.action === "poll")
    return pollAction(params, session, gitRoot, piSessionId, filters, state, pi, options);
  if (params.action === "unpoll") return unpollAction(params, session, filters, state, options);
  return listPollsAction(session, filters, state, options);
};

const runBashInTmux = async (
  params: BashInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const gitRoot = getGitRoot(ctx.cwd);
  if (!gitRoot) return toolError("Error: not in a git repository.");

  state.statusContext = ctx;
  startWatching(state, pi, options);
  const session = tmuxSessionNameForGitRoot(gitRoot, options);
  const piSessionId = ctx.sessionManager.getSessionId();
  const exists = sessionExists(session, options.tmuxBinary);
  const signalDir = getSignalDir(state, options);
  const result = exists
    ? addBashWindow(signalDir, session, gitRoot, piSessionId, params.command, params.name, options)
    : createBashSessionWindow(
        signalDir,
        session,
        gitRoot,
        piSessionId,
        params.command,
        params.name,
        options,
      );
  const signalInfo = {
    session,
    windowId: result.windowId,
    windowIndex: result.index,
    id: result.id,
    startedAt: Date.now(),
    outputFile: result.outputFile,
  };
  const completionSignalFilename = signalFilename(signalInfo);
  state.ownedSignals.add(completionSignalFilename);
  state.signalStartedAt.set(completionSignalFilename, signalInfo.startedAt);
  state.activeSession = session;
  state.activeGitRoot = gitRoot;
  state.activePiSessionId = piSessionId;

  updateBackgroundProcessStatus(ctx, options);

  if (params.background === true) {
    if (params.pollInterval > 0)
      startPoller(
        pi,
        state,
        session,
        result.windowId,
        result.index,
        params.pollInterval,
        params.pollLines,
        options,
        gitRoot,
        piSessionId,
        signalInfo,
      );
    return {
      content: [
        {
          type: "text" as const,
          text: `Started in background tmux window: ${windowNameForCommand(params.command, params.name, options)} ${result.windowId}.${params.pollInterval > 0 ? ` Polling every ${params.pollInterval}s.` : ""}\nResult will be reported when it finishes.\n\n  ${tmuxWindowAttachHint(result.windowId, process.env, options.tmuxBinary)}`,
        },
      ],
      details: undefined,
    };
  }

  onUpdate?.(bashUpdate());
  const stopForegroundUpdates = startForegroundBashOutputUpdates(
    onUpdate,
    result.windowId,
    result.outputFile,
    options,
  );
  state.bashSignals.add(completionSignalFilename);
  const exitCode = await waitForExitCode(signalDir, signal, signalInfo, params.timeout).finally(
    () => {
      stopForegroundUpdates();
      state.bashSignals.delete(completionSignalFilename);
    },
  );
  if (exitCode !== "timeout" || params.timeoutAction !== "background") {
    state.ownedSignals.delete(completionSignalFilename);
    state.signalStartedAt.delete(completionSignalFilename);
  }
  const output = formatTrimmedOutput(
    commandOutputTail(result.windowId, options.bashContextLines, options, result.outputFile),
    result.outputFile,
    shouldShowOutputPath(options),
    outputTruncationOptions(options, options.bashContextLines),
  );
  const text = output.text;

  if (exitCode === "aborted") {
    execSafe(`${tmuxCommand(options)} kill-window -t ${shellQuote(result.windowId)}`);
    updateBackgroundProcessStatus(ctx, options);
    throw new Error(`${text}\n\nCommand aborted`);
  }

  if (exitCode === "timeout") {
    if (params.timeoutAction !== "background") {
      execSafe(`${tmuxCommand(options)} kill-window -t ${shellQuote(result.windowId)}`);
      updateBackgroundProcessStatus(ctx, options);
      throw new Error(`${text}\n\nCommand timed out after ${params.timeout} seconds`);
    }

    if (params.pollInterval > 0)
      startPoller(
        pi,
        state,
        session,
        result.windowId,
        result.index,
        params.pollInterval,
        params.pollLines,
        options,
        gitRoot,
        piSessionId,
        signalInfo,
      );
    const timeoutText = `Still running after ${params.timeout}s in background tmux${params.pollInterval > 0 ? ` and polling every ${params.pollInterval}s` : ""}. Use ${options.tmuxToolName} peek/list/kill to inspect or stop it. Result will be reported when it finishes.`;
    return {
      content: [
        {
          type: "text" as const,
          text: [text, timeoutText].filter(Boolean).join("\n\n"),
        },
      ],
      details: output.details,
    };
  }

  closeWindowOnCompletion(result.windowId, options);
  updateBackgroundProcessStatus(ctx, options);

  if (exitCode !== 0) {
    throw new Error(`${text}\n\nCommand exited with code ${exitCode}`);
  }

  return { content: [{ type: "text" as const, text }], details: output.details };
};

const renderPromptTemplate = (template: string, options: ResolvedOptions): string =>
  template
    .replaceAll("{bashTool}", options.bashToolName)
    .replaceAll("{tmuxTool}", options.tmuxToolName)
    .replaceAll("{attachCommand}", tmuxWindowAttachCommand("@123", process.env, options.tmuxBinary))
    .replaceAll("{defaultTimeoutSeconds}", String(options.defaultTimeoutSeconds))
    .replaceAll("{maxTimeoutSeconds}", String(options.maxTimeoutSeconds))
    .replaceAll("{bashContextLines}", String(options.bashContextLines))
    .replaceAll("{maxOutputKb}", String(options.maxOutputBytes / 1024));

const systemPromptEnabled = (options: ResolvedOptions): boolean => options.systemPrompt;

const availableToolPromptValue = (
  toolName: string,
  options: ResolvedOptions,
): string | false | undefined => {
  const availableTools = options.systemPromptAvailableTools;
  if (Object.prototype.hasOwnProperty.call(availableTools, toolName))
    return availableTools[toolName];
  if (toolName === options.bashToolName) return availableTools["{bashTool}"];
  if (toolName === options.tmuxToolName) return availableTools["{tmuxTool}"];
  return undefined;
};

const availableToolPromptSnippet = (
  toolName: string,
  defaultSnippet: string,
  options: ResolvedOptions,
): string | undefined => {
  if (!systemPromptEnabled(options)) return undefined;

  const value = availableToolPromptValue(toolName, options);
  if (value === false) return undefined;
  return renderPromptTemplate(value ?? defaultSnippet, options);
};

const systemPromptGuidelines = (options: ResolvedOptions): string[] => {
  if (!systemPromptEnabled(options)) return [];

  const guidelines = options.systemPromptGuidelines;
  if (guidelines === false) return [];
  return guidelines.map((guideline) => renderPromptTemplate(guideline, options));
};

const registerBashTool = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
): void => {
  const bashToolCallSchema = buildBashToolCallSchema(options, toolError);

  pi.registerTool({
    name: options.bashToolName,
    label: options.bashToolName,
    description: `Execute a bash command in a background tmux window. Output is truncated to last ${options.bashContextLines} lines or ${options.maxOutputBytes / 1024}KB. Defaults to a ${options.defaultTimeoutSeconds}s timeout, max ${options.maxTimeoutSeconds}s; timeoutAction defaults to "background". Use background for long-running commands.`,
    promptSnippet: availableToolPromptSnippet(
      options.bashToolName,
      DEFAULT_BASH_PROMPT_SNIPPET,
      options,
    ),
    promptGuidelines: systemPromptGuidelines(options),
    parameters: bashToolCallSchema.typeBoxSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return bashToolCallSchema.handleInput(params, (input) =>
        runBashInTmux(input, signal, onUpdate, pi, ctx, state, options),
      );
    },
    renderCall(args, theme, context) {
      startBashRenderTiming(context as ToolRenderContext<BashRenderState, Partial<BashInput>>);
      return new Text(renderBashCallText(args as Partial<BashInput>, theme), 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const bashContext = context as ToolRenderContext<BashRenderState, Partial<BashInput>>;
      const content = result.content?.[0];
      const raw = content?.type === "text" ? content.text : "";

      if (!shouldRenderBashDuration(bashContext.args, raw)) {
        return new Text(renderBackgroundBashResultText(raw, expanded, theme, options), 0, 0);
      }

      updateBashResultTiming(bashContext, isPartial);
      return new Text(
        `\n${renderBashResultText(raw, expanded, isPartial, bashContext.state, theme, options)}`,
        0,
        0,
      );
    },
  });
};

const getTmuxRenderDetails = (details: unknown): TmuxRenderDetails | undefined => {
  if (!details || typeof details !== "object") return undefined;
  const render = (details as { render?: TmuxRenderDetails }).render;
  return render?.summary ? render : undefined;
};

const formatTmuxToolRenderText = (
  raw: string,
  render: TmuxRenderDetails | undefined,
  expanded: boolean,
  theme: TmuxToolRenderTheme,
): string => {
  if (!render) {
    const [summary = "", ...detail] = raw.split("\n");
    return `${theme.fg("success", "✓ ")}${summary}${expanded && detail.length > 0 ? `\n${theme.fg("dim", detail.join("\n"))}` : ""}`;
  }

  const detailLines = expanded
    ? (render.expandedLines ?? render.visibleLines ?? [])
    : (render.collapsedLines ?? render.visibleLines ?? []);

  return [
    `${theme.fg("success", "✓ ")}${render.summary}`,
    ...detailLines,
    ...(render.attachLines ?? []),
  ].join("\n");
};

const registerTool = (pi: ExtensionAPI, state: ExtensionState, options: ResolvedOptions): void => {
  const tmuxToolCallSchema = buildTmuxToolCallSchema(options, toolError);

  pi.registerTool({
    name: options.tmuxToolName,
    label: options.tmuxToolName,
    description: "Inspect and control background tmux windows created by bash.",
    promptSnippet: availableToolPromptSnippet(
      options.tmuxToolName,
      DEFAULT_TMUX_PROMPT_SNIPPET,
      options,
    ),
    promptGuidelines: systemPromptGuidelines(options),
    parameters: tmuxToolCallSchema.typeBoxSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return tmuxToolCallSchema.handleInput(params, (input) =>
        executeTool(input, ctx, state, pi, options),
      );
    },
    renderCall(args, theme) {
      const tmuxArgs = args as Partial<{
        action: string;
        window: number | string;
      }>;
      const action = tmuxArgs.action ?? options.tmuxToolName;
      const windowLabel =
        (action === "peek" || action === "kill" || action === "poll" || action === "unpoll") &&
        tmuxArgs.window !== undefined
          ? ` :${tmuxArgs.window}`
          : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold(`${options.tmuxToolName} `))}${theme.fg("accent", action)}${theme.fg("muted", windowLabel)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const content = result.content?.[0];
      const raw = content?.type === "text" ? content.text : "";
      const render = getTmuxRenderDetails(result.details);

      return new Text(formatTmuxToolRenderText(raw, render, expanded, theme), 0, 0);
    },
  });
};

const registerRenderers = (pi: ExtensionAPI, options: ResolvedOptions): void => {
  pi.registerMessageRenderer("tmux-bash-poll", (message, { expanded }, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const rendered = formatRenderedPollMessage(content, expanded, options);
    const [summary = "", ...detail] = rendered.split("\n");
    return new Text(
      `${theme.fg("success", "↻")} ${summary}${detail.length > 0 ? `\n${theme.fg("dim", detail.join("\n"))}` : ""}`,
      0,
      0,
    );
  });

  pi.registerMessageRenderer("tmux-bash-completion", (message, { expanded }, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const rendered = formatRenderedCompletionMessage(content, expanded, options);
    const [summary = "", ...detail] = rendered.split("\n");
    const icon = content.split("\n")[0]?.includes("failed")
      ? theme.fg("error", "✗")
      : theme.fg("success", "✓");
    return new Text(
      `${icon} ${summary}${detail.length > 0 ? `\n${theme.fg("dim", detail.join("\n"))}` : ""}`,
      0,
      0,
    );
  });
};

export const tmuxBash = (input: TmuxBashOptions = {}) => {
  const options = resolveOptions(input);

  return (pi: ExtensionAPI): void => {
    const state = createState();

    pi.on("session_start", async (_event, ctx) => {
      resetSignalDir(state, options, ctx.sessionManager.getSessionId());
      state.statusContext = ctx;
      const gitRoot = getGitRoot(ctx.cwd);
      state.activeGitRoot = gitRoot;
      state.activePiSessionId = ctx.sessionManager.getSessionId();
      state.activeSession = gitRoot ? tmuxSessionNameForGitRoot(gitRoot, options) : null;
      updateBackgroundProcessStatus(ctx, options);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.setStatus(BACKGROUND_BASH_STATUS_KEY, undefined);
      cleanupState(state, options);
    });

    registerBashTool(pi, state, options);
    registerTool(pi, state, options);
    registerRenderers(pi, options);
  };
};
