import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type BashToolDetails,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { Text, type TUI } from "@mariozechner/pi-tui";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
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
  attachToResolvedSession,
  backgroundSessionName,
  capturePanes,
  DEFAULT_SESSION_NAME_TEMPLATE,
  exec,
  execSafe,
  formatWindowLines,
  getGitRoot,
  getWindows,
  shellQuote,
  sessionExists,
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

export type TmuxBashOptions = {
  projectSessionNameTemplate?: string;
  sessionNameTemplate?: string;
  sessionScope?: "project" | "shared";
  sharedSessionName?: string;
  toolName?: string;
  commandPrefix?: string;
  captureLines?: number;
  completionCaptureLines?: number;
  completionTailLines?: number;
  windowNameTemplate?: string;
  maxWindowNameLength?: number;
  autoKillIdleOnStartup?: boolean;
  autoCloseWindowsOnCompletion?: boolean;
  alwaysShowOutputFilePath?: boolean;
  preserveOutputFiles?: boolean;
  outputDir?: string;
  killSessionOnShutdown?: boolean;
  replaceBashTool?: boolean;
  defaultTimeoutSeconds?: number;
  maxTimeoutSeconds?: number;
  defaultPollInterval?: number;
  defaultPollLines?: number;
  prompt?: string;
};

type FullscreenCommandResult = { ok: true } | { ok: false; message: string };

type ResolvedOptions = Required<Omit<TmuxBashOptions, "sessionNameTemplate">>;
type RawBashInput = {
  command: string;
  name?: string;
  background?: boolean;
  timeout?: number;
  timeoutAction?: "kill" | "background";
  pollInterval?: number;
  pollLines?: number;
};
type SignalInfo = {
  session: string;
  windowId: string;
  windowIndex: number;
  id: string;
  outputFile?: string;
};
type Poller = {
  timer: NodeJS.Timeout;
  session: string;
  windowId: string;
  windowIndex: number;
  gitRoot: string;
  interval: number;
  lines: number;
  signalInfo?: SignalInfo;
};

type PollerDetails = Omit<Poller, "timer" | "signalInfo">;

type ExtensionState = {
  signalDir: string | null;
  watcher: FSWatcher | null;
  bashSignals: Set<string>;
  pollers: Map<string, Poller>;
  activeSession: string | null;
  activeGitRoot: string | null;
  statusContext: ExtensionContext | null;
};

type RunWindowResult = { index: number; windowId: string; id: string; outputFile?: string };
type FormattedOutput = { text: string; details: BashToolDetails | undefined };

export const DEFAULT_OPTIONS: ResolvedOptions = {
  projectSessionNameTemplate: DEFAULT_SESSION_NAME_TEMPLATE,
  sessionScope: "project",
  sharedSessionName: SHARED_SESSION_NAME,
  toolName: "tmux",
  commandPrefix: "tmux",
  captureLines: 50,
  completionCaptureLines: 30,
  completionTailLines: 20,
  windowNameTemplate: "{{nameOrCommand}}",
  maxWindowNameLength: 30,
  autoKillIdleOnStartup: false,
  autoCloseWindowsOnCompletion: true,
  alwaysShowOutputFilePath: false,
  preserveOutputFiles: false,
  outputDir: SIGNAL_BASE,
  killSessionOnShutdown: false,
  replaceBashTool: true,
  defaultTimeoutSeconds: 30,
  maxTimeoutSeconds: 60,
  defaultPollInterval: 0,
  defaultPollLines: 30,
  prompt: "",
};

const assertProjectSessionNameTemplate = (template: string): string => {
  if (!template.includes("{{}}")) {
    throw new Error(
      'projectSessionNameTemplate must include "{{}}" as the project session placeholder',
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
    projectSessionNameTemplate: assertProjectSessionNameTemplate(
      input.projectSessionNameTemplate ??
        input.sessionNameTemplate ??
        DEFAULT_OPTIONS.projectSessionNameTemplate,
    ),
    sessionScope: input.sessionScope ?? DEFAULT_OPTIONS.sessionScope,
    sharedSessionName: nonEmpty(
      "sharedSessionName",
      input.sharedSessionName ?? DEFAULT_OPTIONS.sharedSessionName,
    ),
    toolName: nonEmpty("toolName", input.toolName ?? DEFAULT_OPTIONS.toolName),
    commandPrefix: nonEmpty("commandPrefix", input.commandPrefix ?? DEFAULT_OPTIONS.commandPrefix),
    captureLines: positiveInteger(
      "captureLines",
      input.captureLines ?? DEFAULT_OPTIONS.captureLines,
    ),
    completionCaptureLines: positiveInteger(
      "completionCaptureLines",
      input.completionCaptureLines ?? DEFAULT_OPTIONS.completionCaptureLines,
    ),
    completionTailLines: positiveInteger(
      "completionTailLines",
      input.completionTailLines ?? DEFAULT_OPTIONS.completionTailLines,
    ),
    windowNameTemplate: input.windowNameTemplate ?? DEFAULT_OPTIONS.windowNameTemplate,
    maxWindowNameLength: positiveInteger(
      "maxWindowNameLength",
      input.maxWindowNameLength ?? DEFAULT_OPTIONS.maxWindowNameLength,
    ),
    autoKillIdleOnStartup: input.autoKillIdleOnStartup ?? DEFAULT_OPTIONS.autoKillIdleOnStartup,
    autoCloseWindowsOnCompletion:
      input.autoCloseWindowsOnCompletion ?? DEFAULT_OPTIONS.autoCloseWindowsOnCompletion,
    alwaysShowOutputFilePath:
      input.alwaysShowOutputFilePath ?? DEFAULT_OPTIONS.alwaysShowOutputFilePath,
    preserveOutputFiles: input.preserveOutputFiles ?? DEFAULT_OPTIONS.preserveOutputFiles,
    outputDir: nonEmpty("outputDir", input.outputDir ?? DEFAULT_OPTIONS.outputDir),
    killSessionOnShutdown: input.killSessionOnShutdown ?? DEFAULT_OPTIONS.killSessionOnShutdown,
    replaceBashTool: input.replaceBashTool ?? DEFAULT_OPTIONS.replaceBashTool,
    defaultTimeoutSeconds,
    maxTimeoutSeconds,
    defaultPollInterval: nonNegativeInteger(
      "defaultPollInterval",
      input.defaultPollInterval ?? DEFAULT_OPTIONS.defaultPollInterval,
    ),
    defaultPollLines: positiveInteger(
      "defaultPollLines",
      input.defaultPollLines ?? DEFAULT_OPTIONS.defaultPollLines,
    ),
    prompt: input.prompt ?? DEFAULT_OPTIONS.prompt,
  };
};

export const createState = (): ExtensionState => ({
  signalDir: null,
  watcher: null,
  bashSignals: new Set(),
  pollers: new Map(),
  activeSession: null,
  activeGitRoot: null,
  statusContext: null,
});

const signalDirPath = (options: ResolvedOptions, id: string): string => join(options.outputDir, id);

const getSignalDir = (state: ExtensionState, options: ResolvedOptions): string => {
  if (state.signalDir) return state.signalDir;

  state.signalDir = signalDirPath(options, randomBytes(8).toString("hex"));
  mkdirSync(state.signalDir, { recursive: true });
  return state.signalDir;
};

const resetSignalDir = (
  state: ExtensionState,
  options: ResolvedOptions,
  sessionFile?: string,
): void => {
  const id = sessionFile
    ? Buffer.from(sessionFile).toString("base64url").slice(0, 24)
    : randomBytes(8).toString("hex");
  state.signalDir = signalDirPath(options, id);
  mkdirSync(state.signalDir, { recursive: true });
};

const commandLabel = (cmd: string, name?: string): string =>
  name ??
  cmd
    .split(/[|;&\s]/)[0]
    ?.split("/")
    .pop() ??
  "shell";

const windowNameForCommand = (
  cmd: string,
  name: string | undefined,
  options: ResolvedOptions,
): string =>
  options.windowNameTemplate
    .replaceAll("{{nameOrCommand}}", commandLabel(cmd, name))
    .replaceAll("{{name}}", name ?? "")
    .replaceAll("{{command}}", cmd)
    .slice(0, options.maxWindowNameLength);

const sessionNameForGitRoot = (gitRoot: string, options: ResolvedOptions): string =>
  options.sessionScope === "shared"
    ? options.sharedSessionName
    : backgroundSessionName(gitRoot, options.projectSessionNameTemplate);

const filteredGitRoot = (gitRoot: string, options: ResolvedOptions): string | undefined =>
  options.sessionScope === "shared" ? gitRoot : undefined;

const windowFiltersForPiSession = (
  gitRoot: string,
  piSessionId: string,
  options: ResolvedOptions,
): { gitRoot?: string; piSessionId: string } => ({
  ...(options.sessionScope === "shared" ? { gitRoot } : {}),
  piSessionId,
});

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

const fullOutputSuffix = (fullOutputPath: string | undefined): string =>
  fullOutputPath ? `. Full output: ${fullOutputPath}` : "";

const fullOutputNotice = (fullOutputPath: string): string => `[Full output: ${fullOutputPath}]`;

const shouldShowOutputPath = (options: ResolvedOptions): boolean =>
  options.alwaysShowOutputFilePath || options.autoCloseWindowsOnCompletion;

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
): FormattedOutput => {
  const text = content || emptyText;
  const truncation = truncateTail(text);
  if (!truncation.truncated && (!showFullOutputPath || !fullOutputPath)) {
    return { text, details: undefined };
  }

  if (!truncation.truncated && fullOutputPath) {
    return { text: `${text}\n\n${fullOutputNotice(fullOutputPath)}`, details: { fullOutputPath } };
  }

  return {
    text: `${truncation.content}\n\n${truncationNotice(text, truncation, fullOutputPath)}`,
    details: { truncation, fullOutputPath },
  };
};

const formatOutput = formatTmuxOutputForContext;

const formatTrimmedOutput = (
  content: string,
  fullOutputPath?: string,
  showFullOutputPath = false,
): FormattedOutput =>
  formatOutput(content.trim(), fullOutputPath, "(no output)", showFullOutputPath);

export const formatCompletionSummary = (
  windowTitle: string,
  windowIndex: number,
  exitCode: number,
): string => {
  const status = exitCode === 0 ? "completed successfully" : `exited with code ${exitCode}`;
  return `${windowTitle} ${status} in tmux window :${windowIndex}`;
};

const signalFilename = ({ session, windowId, id }: SignalInfo): string =>
  `${session}.${windowId}.${id}`;

const outputFileForSignal = (signalDir: string, signalInfo: SignalInfo): string =>
  join(signalDir, `${signalFilename(signalInfo)}.out`);

const readOutputFile = (outputFile: string | undefined): string | null => {
  if (!outputFile || !existsSync(outputFile)) return null;
  return readFileSync(outputFile, "utf-8");
};

const closeWindowOnCompletion = (windowId: string, options: ResolvedOptions): void => {
  if (!options.autoCloseWindowsOnCompletion) return;
  execSafe(`tmux kill-window -t ${shellQuote(windowId)}`);
};

const tagWindowGitRoot = (windowId: string, gitRoot: string): void => {
  execSafe(
    `tmux set-window-option -q -t ${shellQuote(windowId)} @pi-tmux-bash-git-root ${shellQuote(gitRoot)}`,
  );
};

const tagWindowPiSession = (windowId: string, piSessionId: string): void => {
  execSafe(
    `tmux set-window-option -q -t ${shellQuote(windowId)} @pi-tmux-bash-pi-session-id ${shellQuote(piSessionId)}`,
  );
};

const createBashCommandScript = (
  signalDir: string,
  session: string,
  cmd: string,
): { id: string; scriptPath: string } => {
  const scriptDir = join(signalDir, "s");
  mkdirSync(scriptDir, { recursive: true });

  const id = randomBytes(4).toString("hex");
  const scriptPath = join(scriptDir, `${session}.${id}.sh`);
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
__signal_dir=${shellQuote(signalDir)}
__session=${shellQuote(session)}
__id=${shellQuote(id)}
__window_id=$(tmux display-message -p -t "\${TMUX_PANE:-}" '#{window_id}' 2>/dev/null || printf '@0')
__signal_file="$__signal_dir/$__session.$__window_id.$__id"
__output_file="$__signal_file.out"
: > "$__output_file"
printf '$ %s\n' ${shellQuote(cmd)}
(
${cmd}
) > >(tee -a "$__output_file") 2>&1
__rc=$?
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

const addBashWindow = (
  signalDir: string,
  session: string,
  gitRoot: string,
  piSessionId: string,
  cmd: string,
  name: string | undefined,
  options: ResolvedOptions,
): RunWindowResult => {
  const script = createBashCommandScript(signalDir, session, cmd);
  const raw = exec(
    `tmux new-window -d -t ${shellQuote(session)} -n ${shellQuote(windowNameForCommand(cmd, name, options))} -c ${shellQuote(gitRoot)} -P -F '#{window_id}|||#{window_index}' ${shellQuote(script.scriptPath)}`,
  );
  const { windowId, index } = parseNewWindowResult(raw);
  tagWindowGitRoot(windowId, gitRoot);
  tagWindowPiSession(windowId, piSessionId);
  return {
    index,
    windowId,
    id: script.id,
    outputFile: outputFileForSignal(signalDir, {
      session,
      windowId,
      windowIndex: index,
      id: script.id,
    }),
  };
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
  const script = createBashCommandScript(signalDir, session, cmd);
  const raw = exec(
    `tmux new-session -d -s ${shellQuote(session)} -n ${shellQuote(windowNameForCommand(cmd, name, options))} -c ${shellQuote(gitRoot)} -P -F '#{window_id}|||#{window_index}' ${shellQuote(script.scriptPath)}`,
  );
  const { windowId, index } = parseNewWindowResult(raw);
  tagWindowGitRoot(windowId, gitRoot);
  tagWindowPiSession(windowId, piSessionId);
  return {
    index,
    windowId,
    id: script.id,
    outputFile: outputFileForSignal(signalDir, {
      session,
      windowId,
      windowIndex: index,
      id: script.id,
    }),
  };
};

const resolveWindowIndex = (
  window: number | string | undefined,
): number | undefined | "invalid" => {
  if (window === undefined) return undefined;
  if (window === "all") return "invalid";

  const index = typeof window === "number" ? window : parseInt(window);
  return Number.isNaN(index) ? "invalid" : index;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

const captureWindowOutput = (windowId: string, lines: number): string =>
  execSafe(`tmux capture-pane -t ${shellQuote(windowId)} -p -S -${lines}`) ?? "";

const commandOutput = (windowId: string, lines: number, outputFile?: string): string =>
  readOutputFile(outputFile) ?? captureWindowOutput(windowId, lines);

const pollerKey = (session: string, windowId: string): string => `${session}:${windowId}`;

const readSignalExitCode = (state: ExtensionState, signalInfo?: SignalInfo): number | undefined => {
  if (!signalInfo || !state.signalDir) return undefined;

  const filename = signalFilename(signalInfo);
  const signalFile = join(state.signalDir, filename);
  if (!existsSync(signalFile)) return undefined;

  const exitCode = parseInt(readFileSync(signalFile, "utf-8").trim());
  unlinkSync(signalFile);
  state.bashSignals.delete(filename);
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
  filters: { gitRoot?: string; piSessionId: string },
): number => {
  const raw = execSafe(
    `tmux list-windows -t ${shellQuote(session)} -F '#{pane_current_command}|||#{pane_pid}|||#{@pi-tmux-bash-git-root}|||#{@pi-tmux-bash-pi-session-id}'`,
  );
  if (!raw) return 0;

  return raw
    .split("\n")
    .map((line) => {
      const [command = "", pid = "", gitRoot = "", piSessionId = ""] = line.split("|||");
      return { command, pid, gitRoot, piSessionId };
    })
    .filter((window) => filters.gitRoot === undefined || window.gitRoot === filters.gitRoot)
    .filter((window) => window.piSessionId === filters.piSessionId)
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

  const session = sessionNameForGitRoot(gitRoot, options);
  const filters = windowFiltersForPiSession(gitRoot, ctx.sessionManager.getSessionId(), options);
  const count = sessionExists(session) ? countRunningBackgroundProcesses(session, filters) : 0;
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
  interval,
  lines,
}: Poller): PollerDetails => ({
  session,
  windowId,
  windowIndex,
  gitRoot,
  interval,
  lines,
});

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
  signalInfo?: SignalInfo,
): void => {
  if (interval <= 0) return;

  stopPoller(state, session, windowId);
  const timer = setInterval(() => {
    const window = getWindows(session, filteredGitRoot(gitRoot, options)).find(
      (item) => item.id === windowId,
    );
    if (!window) {
      stopPoller(state, session, windowId);
      updateStoredBackgroundProcessStatus(state, options);
      return;
    }

    const output = formatTrimmedOutput(
      commandOutput(windowId, lines, signalInfo?.outputFile),
      signalInfo?.outputFile,
      shouldShowOutputPath(options),
    ).text;
    const exitCode = readSignalExitCode(state, signalInfo);
    const completed = exitCode !== undefined;
    if (completed) stopPoller(state, session, windowId);

    pi.sendMessage(
      {
        customType: completed ? "tmux-bash-completion" : "tmux-bash-poll",
        content: completed
          ? `${formatCompletionSummary(window.title, window.index, exitCode)}.

\`\`\`\n${output}\n\`\`\``
          : `tmux window "${window.title}" (:${window.index}) poll.

\`\`\`\n${output}\n\`\`\``,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
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
): void => {
  const parsed = parseSignalFilename(filename);
  if (!parsed) return;

  const exitCode = readFileSync(filepath, "utf-8").trim();
  if (!/^-?\d+$/.test(exitCode)) return;
  unlinkSync(filepath);

  const win = getWindows(parsed.session).find((item) => item.id === parsed.windowId);
  const windowIndex = win?.index ?? parsed.windowIndex;
  const winName = win?.title ?? `window ${windowIndex}`;
  const outputFile = `${filepath}.out`;
  const fileOutput = readOutputFile(outputFile);
  const rawOutput =
    fileOutput ??
    execSafe(
      `tmux capture-pane -t ${shellQuote(parsed.windowId)} -p -S -${options.completionCaptureLines}`,
    );
  const output = formatOutput(
    trimOutput(rawOutput, options.completionTailLines),
    fileOutput === null ? undefined : outputFile,
    "(no output)",
    shouldShowOutputPath(options),
  ).text;
  const code = parseInt(exitCode);
  stopPoller(state, parsed.session, parsed.windowId);

  pi.sendMessage(
    {
      customType: "tmux-bash-completion",
      content: `${formatCompletionSummary(winName, windowIndex, code)}.\n\n\`\`\`\n${output}\n\`\`\``,
      display: true,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
  closeWindowOnCompletion(parsed.windowId, options);
  updateStoredBackgroundProcessStatus(state, options);
};

const handleSignalFile = (
  state: ExtensionState,
  pi: ExtensionAPI,
  signalDir: string,
  filename: string,
  options: ResolvedOptions,
): void => {
  if (state.bashSignals.has(filename)) return;

  const filepath = join(signalDir, filename);
  if (!existsSync(filepath)) return;

  try {
    handleCompletionSignal(state, pi, filepath, filename, options);
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
  state.statusContext = null;

  if (state.signalDir) {
    cleanupSignalDir(state.signalDir, options.preserveOutputFiles);
    state.signalDir = null;
  }
};

const toolText = (text: string, details: unknown = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const toolError = (text: string) => ({ ...toolText(text), isError: true });

const attachAction = (
  params: Extract<TmuxInput, { action: "attach" }>,
  session: string,
  gitRoot: string,
  options: ResolvedOptions,
) => {
  if (!sessionExists(session)) return toolError(`No background session '${session}' to attach to.`);

  const windowIndex = resolveWindowIndex(params.window);
  if (windowIndex === "invalid")
    return toolError("Error: 'window' must be a numeric index for attach action.");

  const filter = filteredGitRoot(gitRoot, options);
  const windows = getWindows(session, filter);
  const projectWindow = windows.find((window) => window.active) ?? windows.at(0);
  const targetWindow =
    options.sessionScope === "shared" ? (windowIndex ?? projectWindow?.index) : windowIndex;
  if (options.sessionScope === "shared" && targetWindow === undefined) {
    return toolError(`No background tmux windows for ${gitRoot} in session ${session}.`);
  }

  const msg = attachToResolvedSession(session, targetWindow, filter);
  const failed = msg.startsWith("Failed") || msg.startsWith("No ");
  return {
    content: [{ type: "text" as const, text: msg }],
    details: { session, ...(targetWindow !== undefined ? { windowIndex: targetWindow } : {}) },
    ...(failed ? { isError: true } : {}),
  };
};

const peekAction = (
  params: Extract<TmuxInput, { action: "peek" }>,
  session: string,
  gitRoot: string,
  options: ResolvedOptions,
) => {
  if (!sessionExists(session)) return toolError(`No background session '${session}'.`);

  const windowIndex =
    params.window === undefined || params.window === "all"
      ? "all"
      : resolveWindowIndex(params.window);
  const target = windowIndex === "invalid" || windowIndex === undefined ? "all" : windowIndex;
  const output = formatOutput(
    capturePanes(session, target, options.captureLines, filteredGitRoot(gitRoot, options)),
  );
  return {
    content: [{ type: "text" as const, text: output.text }],
    details: { session, ...output.details },
  };
};

const listAction = (session: string, gitRoot: string, options: ResolvedOptions) => {
  if (!sessionExists(session)) return toolError(`No background session '${session}'.`);

  const filtered = options.sessionScope === "shared";
  const windows = getWindows(session, filteredGitRoot(gitRoot, options));
  const lines = formatWindowLines(windows);
  return {
    content: [
      {
        type: "text" as const,
        text: `Background session ${session} — ${windows.length} ${filtered ? "project " : ""}window(s)\n${lines.join("\n")}`,
      },
    ],
    details: { session, windows },
  };
};

const killAction = (session: string, gitRoot: string, options: ResolvedOptions) => {
  if (!sessionExists(session)) return toolText(`No background session '${session}' to kill.`);
  if (options.sessionScope !== "shared") {
    exec(`tmux kill-session -t ${shellQuote(session)}`);
    return toolText(`Killed background session ${session}.`);
  }

  const windows = getWindows(session, gitRoot);
  windows.forEach((window) =>
    execSafe(`tmux kill-window -t ${shellQuote(`${session}:${window.index}`)}`),
  );
  return toolText(`Killed ${windows.length} background window(s) for ${gitRoot} in ${session}.`);
};

const pollAction = (
  params: Extract<TmuxInput, { action: "poll" }>,
  session: string,
  gitRoot: string,
  state: ExtensionState,
  pi: ExtensionAPI,
  options: ResolvedOptions,
) => {
  const windowIndex = resolveWindowIndex(params.window);
  if (windowIndex === undefined || windowIndex === "invalid") {
    return toolError("Error: 'window' (index) required for poll action.");
  }

  const window = getWindows(session, filteredGitRoot(gitRoot, options)).find(
    (item) => item.index === windowIndex,
  );
  if (!window) return toolError(`No tmux window :${windowIndex} in session ${session}.`);

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
  );
  return toolText(`Polling "${window.title}" (:${windowIndex}) every ${params.pollInterval}s.`);
};

const unpollAction = (
  params: Extract<TmuxInput, { action: "unpoll" }>,
  session: string,
  gitRoot: string,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const windowIndex = resolveWindowIndex(params.window);
  if (windowIndex === undefined || windowIndex === "invalid") {
    return toolError("Error: 'window' (index) required for unpoll action.");
  }

  const window = getWindows(session, filteredGitRoot(gitRoot, options)).find(
    (item) => item.index === windowIndex,
  );
  if (!window) return toolError(`No tmux window :${windowIndex} in session ${session}.`);

  return toolText(
    stopPoller(state, session, window.id)
      ? `Stopped polling tmux window :${windowIndex}.`
      : `No poller for tmux window :${windowIndex}.`,
  );
};

const listPollsAction = (
  session: string,
  gitRoot: string,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const pollers = [...state.pollers.values()]
    .filter((poller) => poller.session === session)
    .filter((poller) => options.sessionScope !== "shared" || poller.gitRoot === gitRoot);
  if (pollers.length === 0) return toolText("No active pollers.");

  const details = pollers.map(pollerDetails);
  return toolText(
    `Active pollers:\n${details
      .map((poller) => `  :${poller.windowIndex} every ${poller.interval}s (${poller.lines} lines)`)
      .join("\n")}`,
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

  const session = sessionNameForGitRoot(gitRoot, options);
  if (params.action === "attach") return attachAction(params, session, gitRoot, options);
  if (params.action === "peek") return peekAction(params, session, gitRoot, options);
  if (params.action === "list") return listAction(session, gitRoot, options);
  if (params.action === "kill") {
    const result = killAction(session, gitRoot, options);
    updateBackgroundProcessStatus(ctx, options);
    return result;
  }
  if (params.action === "poll") return pollAction(params, session, gitRoot, state, pi, options);
  if (params.action === "unpoll") return unpollAction(params, session, gitRoot, state, options);
  return listPollsAction(session, gitRoot, state, options);
};

const runBashInTmux = async (
  params: BashInput,
  signal: AbortSignal | undefined,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const gitRoot = getGitRoot(ctx.cwd);
  if (!gitRoot) return toolError("Error: not in a git repository.");

  state.statusContext = ctx;
  startWatching(state, pi, options);
  const session = sessionNameForGitRoot(gitRoot, options);
  const piSessionId = ctx.sessionManager.getSessionId();
  const exists = sessionExists(session);
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
    outputFile: result.outputFile,
  };
  const completionSignalFilename = signalFilename(signalInfo);
  state.activeSession = session;
  state.activeGitRoot = gitRoot;

  updateBackgroundProcessStatus(ctx, options);

  if (params.background === true) {
    if (params.pollInterval > 0) state.bashSignals.add(completionSignalFilename);
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
        signalInfo,
      );
    return {
      content: [
        {
          type: "text" as const,
          text: `Started in tmux window${params.pollInterval > 0 ? ` and polling every ${params.pollInterval}s` : ""}.`,
        },
      ],
      details: undefined,
    };
  }

  state.bashSignals.add(completionSignalFilename);
  const exitCode = await waitForExitCode(signalDir, signal, signalInfo, params.timeout);
  state.bashSignals.delete(completionSignalFilename);
  const output = formatTrimmedOutput(
    commandOutput(result.windowId, options.captureLines, result.outputFile),
    result.outputFile,
    shouldShowOutputPath(options),
  );
  const text = output.text;

  if (exitCode === "aborted") {
    execSafe(`tmux kill-window -t ${shellQuote(result.windowId)}`);
    updateBackgroundProcessStatus(ctx, options);
    return {
      content: [{ type: "text" as const, text: `${text}\n\nCommand aborted` }],
      details: output.details,
      isError: true,
    };
  }

  if (exitCode === "timeout") {
    if (params.timeoutAction !== "background") {
      execSafe(`tmux kill-window -t ${shellQuote(result.windowId)}`);
      updateBackgroundProcessStatus(ctx, options);
      return {
        content: [
          {
            type: "text" as const,
            text: `${text}\n\nCommand timed out after ${params.timeout} seconds and tmux window :${result.index} was killed.`,
          },
        ],
        details: output.details,
        isError: true,
      };
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
        signalInfo,
      );
    return {
      content: [
        {
          type: "text" as const,
          text: `${text}\n\nCommand is still running after ${params.timeout} seconds in tmux window :${result.index}${params.pollInterval > 0 ? ` and polling every ${params.pollInterval}s` : ""}. Use ${options.toolName} peek/list/kill to inspect or stop it.`,
        },
      ],
      details: output.details,
    };
  }

  closeWindowOnCompletion(result.windowId, options);
  updateBackgroundProcessStatus(ctx, options);

  if (exitCode !== 0) {
    return {
      content: [{ type: "text" as const, text: `${text}\n\nCommand exited with code ${exitCode}` }],
      details: output.details,
      isError: true,
    };
  }

  return { content: [{ type: "text" as const, text }], details: output.details };
};

const expandHomePath = (path: string): string =>
  path === "~" || path.startsWith("~/") ? `${process.env.HOME ?? ""}${path.slice(1)}` : path;

const runFullscreenCommand = (tui: TUI, command: string, cwd: string): FullscreenCommandResult => {
  tui.stop();

  try {
    const result = spawnSync(expandHomePath(command), { cwd, shell: true, stdio: "inherit" });
    if (result.error) return { ok: false, message: result.error.message };
    if (result.signal) return { ok: false, message: `Exited with signal ${result.signal}.` };
    if (result.status !== null && result.status !== 0) {
      return { ok: false, message: `Exited with code ${result.status}.` };
    }
    return { ok: true };
  } finally {
    tui.start();
    tui.requestRender(true);
  }
};

const createFullscreenCommandLauncher = (
  tui: TUI,
  command: string,
  cwd: string,
  label: string,
  done: (result: FullscreenCommandResult) => void,
): Text => {
  setTimeout(() => done(runFullscreenCommand(tui, command, cwd)), 0);
  return new Text(label, 0, 0);
};

const sidecarWindowPickerCommand = (
  session: string,
  filters: { gitRoot?: string; piSessionId: string },
): string => {
  const script = `
session=${shellQuote(session)}
git_root_filter=${shellQuote(filters.gitRoot ?? "")}
pi_session_filter=${shellQuote(filters.piSessionId)}
if ! command -v fzf >/dev/null 2>&1; then
  printf 'fzf is required\n' >&2
  exit 1
fi
if ! tmux has-session -t "$session" 2>/dev/null; then
  printf 'No tmux session: %s\n' "$session" >&2
  exit 1
fi
selected=$(tmux list-windows -t "$session" -F '#{window_activity}'$'\t''#{window_id}'$'\t''#{window_index}'$'\t''#{window_name}'$'\t''#{window_active}'$'\t''#{pane_current_command}'$'\t''#{pane_current_path}'$'\t''#{@pi-tmux-bash-git-root}'$'\t''#{@pi-tmux-bash-pi-session-id}' 2>/dev/null \
  | awk -F '\t' -v git_root_filter="$git_root_filter" -v pi_session_filter="$pi_session_filter" '(git_root_filter == "" || $8 == git_root_filter) && $9 == pi_session_filter { active = ($5 == "1") ? "  \\033[32m(active)\\033[39m" : ""; printf "%s\\t%s\\t%s\\t\\033[34m:%s\\033[39m %s  \\033[90m%s  %s%s\\033[39m\\n", $1, $2, $3, $3, $4, $6, $7, active }' \
  | sort -t $'\t' -k1,1nr \
  | cut -f2- \
  | fzf --ansi --no-sort \
      --border-label " $session windows " --prompt '' \
      --delimiter=$'\t' --with-nth=3.. \
      --header '  enter switch | ^q kill | tab/down next | shift-tab/up prev' \
      --bind 'tab:down,btab:up' \
      --bind 'ctrl-q:execute-silent(tmux kill-window -t {1})+abort' \
      --preview-window 'right:55%,<65(down,75%)' \
      --layout=reverse \
      --preview 'tmux capture-pane -ep -t {1} -S - 2>/dev/null || echo "No window"')
if [[ -n "$selected" ]]; then
  IFS=$'\t' read -r target _ <<< "$selected"
  tmux switch-client -t "$target" 2>/dev/null || tmux select-window -t "$target"
fi
`;
  return `bash -lc ${shellQuote(script)}`;
};

const clearIdleWindows = (session: string, gitRoot?: string): number | "missing" => {
  const raw = execSafe(
    `tmux list-windows -t ${shellQuote(session)} -F '#{window_index}|||#{window_name}|||#{pane_current_command}|||#{pane_pid}|||#{@pi-tmux-bash-git-root}'`,
  );
  if (!raw) return "missing";

  const idle = raw
    .split("\n")
    .map((line) => {
      const [index = "0", name = "", cmd = "", pid = "", windowGitRoot = ""] = line.split("|||");
      return { index: parseInt(index), name, cmd, pid, gitRoot: windowGitRoot };
    })
    .filter((window) => gitRoot === undefined || window.gitRoot === gitRoot)
    .filter((window) => ["bash", "zsh", "sh", "fish", "dash"].includes(window.cmd))
    .filter((window) => !execSafe(`pgrep -P ${shellQuote(window.pid)}`));

  idle.forEach((window) =>
    execSafe(`tmux kill-window -t ${shellQuote(`${session}:${window.index}`)}`),
  );
  return idle.length;
};

const openProjectWindowPicker = async (
  ctx: ExtensionCommandContext,
  options: ResolvedOptions,
): Promise<void> => {
  if (!ctx.hasUI) {
    ctx.ui.notify("/tmux requires interactive mode.", "error");
    return;
  }

  const gitRoot = getGitRoot(ctx.cwd);
  if (!gitRoot) {
    ctx.ui.notify("Not in a git repository.", "error");
    return;
  }

  const session = sessionNameForGitRoot(gitRoot, options);
  const filters = windowFiltersForPiSession(gitRoot, ctx.sessionManager.getSessionId(), options);
  if (!sessionExists(session)) {
    ctx.ui.notify(`No tmux session '${session}' for this project.`, "error");
    return;
  }

  if (getWindows(session, filters).length === 0) {
    ctx.ui.notify(`No tmux windows for this pi session in '${session}'.`, "error");
    return;
  }

  const result = await ctx.ui.custom<FullscreenCommandResult>((tui, _theme, _keybindings, done) =>
    createFullscreenCommandLauncher(
      tui,
      sidecarWindowPickerCommand(session, filters),
      ctx.cwd,
      "Opening sidecar tmux window picker…",
      done,
    ),
  );
  if (!result.ok) ctx.ui.notify(`tmux window picker failed: ${result.message}`, "error");
};

const registerCommands = (pi: ExtensionAPI, options: ResolvedOptions): void => {
  pi.registerCommand(options.commandPrefix, {
    description: "Open a fullscreen fzf picker for this pi session's sidecar tmux windows",
    handler: async (_args, ctx) => {
      await openProjectWindowPicker(ctx, options);
    },
  });

  pi.registerCommand(`${options.commandPrefix}:cat`, {
    description: "Capture background tmux window output and bring it into the conversation",
    handler: async (_args, ctx) => {
      const gitRoot = getGitRoot(ctx.cwd);
      if (!gitRoot) {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }

      const session = sessionNameForGitRoot(gitRoot, options);
      if (!sessionExists(session)) {
        ctx.ui.notify("No background tmux session for this project.", "error");
        return;
      }

      const windows = getWindows(session, filteredGitRoot(gitRoot, options));
      const choices = [
        "all windows",
        ...windows.map((item) => `:${item.index}  ${item.title}${item.active ? "  (active)" : ""}`),
      ];
      const choice = await ctx.ui.select("Capture output from:", choices);
      if (choice === undefined || choice === null) return;

      const target =
        choice === "all windows" ? "all" : windows[choices.indexOf(String(choice)) - 1]?.index;
      if (target === undefined) {
        ctx.ui.notify("Invalid window selection.", "error");
        return;
      }

      const output = formatOutput(
        capturePanes(session, target, options.captureLines, filteredGitRoot(gitRoot, options)),
      );
      pi.sendUserMessage(`Here is the background tmux output:\n\n\`\`\`\n${output.text}\n\`\`\``, {
        deliverAs: "followUp",
      });
    },
  });

  pi.registerCommand(`${options.commandPrefix}:clear`, {
    description: "Kill background tmux windows where the command has finished",
    handler: async (_args, ctx) => {
      const gitRoot = getGitRoot(ctx.cwd);
      if (!gitRoot) {
        ctx.ui.notify("Not in a git repository.", "error");
        return;
      }

      const session = sessionNameForGitRoot(gitRoot, options);
      const count = clearIdleWindows(session, filteredGitRoot(gitRoot, options));
      if (count === "missing") {
        ctx.ui.notify("No background tmux session for this project.", "error");
        return;
      }

      updateBackgroundProcessStatus(ctx, options);
      ctx.ui.notify(
        count === 0 ? "No idle windows to clear." : `Cleared ${count} idle window(s).`,
        "info",
      );
    },
  });
};

const registerBashTool = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
): void => {
  if (!options.replaceBashTool) return;

  const bashToolCallSchema = buildBashToolCallSchema(options, toolError);

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: `Execute a bash command in a background tmux window. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Defaults to a ${options.defaultTimeoutSeconds}s timeout, max ${options.maxTimeoutSeconds}s; timeoutAction defaults to "background". Use background for long-running commands.`,
    promptSnippet: "Execute bash commands in background tmux windows",
    promptGuidelines: [
      'Use bash with background: true or timeoutAction: "background" for long-running commands, servers, watchers, REPLs, interactive prompts, and background jobs.',
      "Use pollInterval when periodic check-ins would be helpful.",
      `Use ${options.toolName} peek/list/kill/poll/unpoll to inspect, poll, or stop bash commands that are left running in tmux.`,
      ...(options.prompt.trim() ? [options.prompt.trim()] : []),
    ],
    parameters: bashToolCallSchema.typeBoxSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return bashToolCallSchema.handleInput(params, (input) =>
        runBashInTmux(input, signal, pi, ctx, state, options),
      );
    },
    renderCall(args, theme) {
      const bashArgs = args as Partial<RawBashInput>;
      const timeout = bashArgs.timeout ? theme.fg("muted", ` (timeout ${bashArgs.timeout}s)`) : "";
      const timeoutAction = bashArgs.timeoutAction
        ? theme.fg("muted", ` ${bashArgs.timeoutAction}`)
        : "";
      return new Text(
        theme.fg("toolTitle", theme.bold(`$ ${bashArgs.command ?? "..."}`)) +
          timeout +
          timeoutAction,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const content = result.content?.[0];
      const raw = content?.type === "text" ? content.text : "";
      const [summary = "", ...detail] = raw.split("\n");
      const body = expanded ? raw : [summary, ...detail.slice(-5)].join("\n");
      return new Text(theme.fg("toolOutput", body), 0, 0);
    },
  });
};

const registerTool = (pi: ExtensionAPI, state: ExtensionState, options: ResolvedOptions): void => {
  const tmuxToolCallSchema = buildTmuxToolCallSchema(options, toolError);

  pi.registerTool({
    name: options.toolName,
    label: options.toolName,
    description: "Inspect and control background tmux windows created by bash.",
    promptSnippet: "Inspect and control the background tmux sessions created by bash tool",
    promptGuidelines: [
      `Use ${options.toolName} poll/unpoll to start or stop periodic check-ins for an existing background window.`,
      ...(options.prompt.trim() ? [options.prompt.trim()] : []),
    ],
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
      const action = tmuxArgs.action ?? options.toolName;
      const windowLabel =
        (action === "attach" || action === "peek" || action === "poll" || action === "unpoll") &&
        tmuxArgs.window !== undefined
          ? ` :${tmuxArgs.window}`
          : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold(`${options.toolName} `))}${theme.fg("accent", action)}${theme.fg("muted", windowLabel)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const content = result.content?.[0];
      const raw = content?.type === "text" ? content.text : "";

      const [summary = "", ...detail] = raw.split("\n");
      const text = `${theme.fg("success", "✓ ")}${summary}${expanded && detail.length > 0 ? `\n${theme.fg("dim", detail.join("\n"))}` : ""}`;
      return new Text(text, 0, 0);
    },
  });
};

const registerRenderers = (pi: ExtensionAPI): void => {
  pi.registerMessageRenderer("tmux-bash-completion", (message, { expanded }, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const [summary = "", ...detail] = content.split("\n");
    const icon = summary.includes("successfully")
      ? theme.fg("success", "✓")
      : theme.fg("error", "✗");
    return new Text(
      `${icon} ${summary}${expanded && detail.length > 0 ? `\n${theme.fg("dim", detail.join("\n"))}` : ""}`,
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
      resetSignalDir(state, options, ctx.sessionManager.getSessionFile() ?? undefined);
      state.statusContext = ctx;
      const gitRoot = getGitRoot(ctx.cwd);
      state.activeGitRoot = gitRoot;
      state.activeSession = gitRoot ? sessionNameForGitRoot(gitRoot, options) : null;
      if (state.activeSession && options.autoKillIdleOnStartup)
        clearIdleWindows(
          state.activeSession,
          gitRoot ? filteredGitRoot(gitRoot, options) : undefined,
        );
      updateBackgroundProcessStatus(ctx, options);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.setStatus(BACKGROUND_BASH_STATUS_KEY, undefined);
      if (state.activeSession && options.killSessionOnShutdown) {
        if (options.sessionScope === "shared" && state.activeGitRoot) {
          getWindows(state.activeSession, state.activeGitRoot).forEach((window) =>
            execSafe(`tmux kill-window -t ${shellQuote(`${state.activeSession}:${window.index}`)}`),
          );
        } else {
          execSafe(`tmux kill-session -t ${shellQuote(state.activeSession)}`);
        }
      }
      cleanupState(state, options);
    });

    registerCommands(pi, options);
    registerBashTool(pi, state, options);
    registerTool(pi, state, options);
    registerRenderers(pi);
  };
};
