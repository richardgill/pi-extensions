import {
  type AgentToolUpdateCallback,
  type BashToolDetails,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
  calcTmuxSessionName,
  exec,
  execSafe,
  formatWindowLines,
  getGitRoot,
  getWindows,
  shellQuote,
  sessionExists,
  TMUX_WINDOW_OPTIONS,
  tmuxFormatOption,
  tmuxWindowAttachHint,
  tmuxWindowFiltersForScope,
  type TmuxWindow,
  type TmuxWindowFilters,
} from "./tmux-utils";
import {
  BACKGROUND_BASH_STATUS_KEY,
  DEFAULT_OPTIONS,
  SHELL_IDENTIFIER_REGEX,
  type ResolvedOptions,
  type TmuxAction,
} from "./config";
import type { BashInput, TmuxInput } from "./tool-call-schemas";
import {
  displayCommandForCommand,
  formatCompletionSummary,
  formatRenderedBashResult,
  formatTmuxOutputForContext as formatOutput,
  hasOnlyEmptyBashOutput,
  indentDisplayLine,
  indentDisplayLines,
  type CompletionMessageRenderDetails,
  type FormattedOutput,
  type PollMessageRenderDetails,
} from "./render";

type TmuxRenderDetails = {
  summary: string;
  expandedLines: string[];
  collapsedLines: string[];
  attachLines?: string[];
};

type CommandRunInfo = {
  session: string;
  windowId: string;
  id: string;
  outputFile?: string;
};

type Poller = {
  timer: NodeJS.Timeout;
  session: string;
  windowId: string;
  gitRoot: string;
  piSessionId: string;
  interval: number;
  lines: number;
  commandRun?: CommandRunInfo;
};

type PollerDetails = Omit<Poller, "timer" | "commandRun">;

export type ExtensionState = {
  runDir: string | null;
  watcher: FSWatcher | null;
  foregroundExitCodeFiles: Set<string>;
  ownedExitCodeFiles: Set<string>;
  pollers: Map<string, Poller>;
  pendingPollMessageTimers: Set<NodeJS.Timeout>;
  statusContext: ExtensionContext | null;
};

type RunWindowResult = {
  windowId: string;
  id: string;
  outputFile?: string;
};

// Bash windows report completion by writing an exit-code file; the .out sibling keeps exact output for truncation and UI replay.
export const createState = (): ExtensionState => ({
  runDir: null,
  watcher: null,
  foregroundExitCodeFiles: new Set(),
  ownedExitCodeFiles: new Set(),
  pollers: new Map(),
  pendingPollMessageTimers: new Set(),
  statusContext: null,
});

// runDir is a temp folder we create to store Pi session's exit-code files, and captured .out files.
const runDirPath = (options: ResolvedOptions, id: string): string => join(options.outputDir, id);

const getRunDir = (state: ExtensionState, options: ResolvedOptions): string => {
  if (state.runDir) return state.runDir;

  state.runDir = runDirPath(options, randomBytes(8).toString("hex"));
  mkdirSync(state.runDir, { recursive: true, mode: 0o700 });
  chmodSync(state.runDir, 0o700);
  return state.runDir;
};

export const resetRunDir = (
  state: ExtensionState,
  options: ResolvedOptions,
  sessionId: string,
): void => {
  const encodedSessionId = Buffer.from(sessionId).toString("base64url").slice(0, 24);
  const id = `${encodedSessionId}-${process.pid}-${randomBytes(4).toString("hex")}`;
  state.runDir = runDirPath(options, id);
  mkdirSync(state.runDir, { recursive: true, mode: 0o700 });
  chmodSync(state.runDir, 0o700);
};

const commandLabel = (cmd: string, name: string | undefined, options: ResolvedOptions): string => {
  if (name) return name;

  const displayCommand = displayCommandForCommand(cmd, options.displayCommandStartMarker);
  const firstWord = displayCommand.split(/[|;&\s]/)[0];
  return firstWord?.split("/").pop() || "shell";
};

const replaceTmuxWindowNameVariable = (template: string, variable: string, value: string): string =>
  template.replace(new RegExp(`{{\\s*${variable}\\s*}}`, "g"), value);

const tmuxWindowNameForCommand = (
  cmd: string,
  name: string | undefined,
  options: ResolvedOptions,
): string => {
  const displayCommand = displayCommandForCommand(cmd, options.displayCommandStartMarker);
  return Object.entries({
    command: displayCommand,
    name: name ?? "",
    nameOrCommand: commandLabel(cmd, name, options),
  })
    .reduce(
      (text, [variable, value]) => replaceTmuxWindowNameVariable(text, variable, value),
      options.tmuxWindowNameTemplate,
    )
    .slice(0, options.maxTmuxWindowNameLength);
};

// Parse from the right so tmux session names can contain dots.
const parseExitCodeFilename = (filename: string): CommandRunInfo | null => {
  const lastDot = filename.lastIndexOf(".");
  const secondLastDot = filename.lastIndexOf(".", lastDot - 1);
  if (secondLastDot === -1) return null;

  const session = filename.slice(0, secondLastDot);
  const windowTarget = filename.slice(secondLastDot + 1, lastDot);
  if (!windowTarget) return null;

  return {
    session,
    windowId: windowTarget.startsWith("@") ? windowTarget : `@${windowTarget}`,
    id: filename.slice(lastDot + 1),
  };
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

  const output = formatOutput(
    commandOutputTail(windowId, options.bashContextLines, options, outputFile),
    {
      fullOutputPath: outputFile,
      showFullOutputPath: options.alwaysShowOutputFilePath,
      truncationOptions: {
        maxLines: options.bashContextLines,
        maxBytes: options.maxOutputBytes,
      },
    },
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
  const timer = setInterval(update, options.foregroundBashUpdateIntervalMs);

  update();
  return () => clearInterval(timer);
};

const exitCodeFilename = ({ session, windowId, id }: CommandRunInfo): string =>
  `${session}.${windowId}.${id}`;

const outputFileForRun = (runDir: string, commandRun: CommandRunInfo): string =>
  join(runDir, `${exitCodeFilename(commandRun)}.out`);

const readOutputFile = (outputFile: string | undefined): string | null => {
  if (!outputFile || !existsSync(outputFile)) return null;
  return readFileSync(outputFile, "utf-8");
};

const tmuxCommand = (options: ResolvedOptions): string => shellQuote(options.tmuxBinary);

const closeWindowOnCompletion = (windowId: string, options: ResolvedOptions): void => {
  if (!options.autoCloseWindowsOnCompletion) return;
  execSafe(`${tmuxCommand(options)} kill-window -t ${shellQuote(windowId)}`);
};

const setWindowOptions = (
  windowId: string,
  values: Record<string, string>,
  options: ResolvedOptions,
): void => {
  Object.entries(values).forEach(([option, value]) => {
    execSafe(
      `${tmuxCommand(options)} set-window-option -q -t ${shellQuote(windowId)} ${option} ${shellQuote(value)}`,
    );
  });
};

const isExportableEnvironmentName = (name: string, denylist: ReadonlySet<string>): boolean =>
  SHELL_IDENTIFIER_REGEX.test(name) && !denylist.has(name);

export const formatEnvironmentExportsForBash = (
  env: NodeJS.ProcessEnv = process.env,
  denylist: readonly string[] = DEFAULT_OPTIONS.tmuxEnvExportDenylist,
): string => {
  const deniedNames = new Set(denylist);
  return Object.entries(env)
    .filter(
      ([name, value]) => value !== undefined && isExportableEnvironmentName(name, deniedNames),
    )
    .map(([name, value]) => `export ${name}=${shellQuote(value ?? "")}`)
    .join("\n");
};

// The script tees exact output, writes an exit-code sentinel, then stays attachable as a login shell.
const createBashCommandScript = (
  runDir: string,
  session: string,
  cmd: string,
  displayCommand: string,
  options: ResolvedOptions,
): { id: string; scriptPath: string } => {
  const scriptDir = join(runDir, "s");
  mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
  chmodSync(scriptDir, 0o700);

  const id = randomBytes(4).toString("hex");
  const scriptPath = join(scriptDir, `${session}.${id}.sh`);
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
__run_dir=${shellQuote(runDir)}
__session=${shellQuote(session)}
__id=${shellQuote(id)}
__tmux_binary=${shellQuote(options.tmuxBinary)}
__window_id=$("$__tmux_binary" display-message -p -t "\${TMUX_PANE:-}" '#{window_id}' 2>/dev/null || printf '@0')
__exit_code_file="$__run_dir/$__session.$__window_id.$__id"
__output_file="$__exit_code_file.out"
: > "$__output_file"
printf '$ %s\n' ${shellQuote(displayCommand)}
${formatEnvironmentExportsForBash(process.env, options.tmuxEnvExportDenylist)}
(
${cmd}
) 2>&1 | tee -a "$__output_file"
__rc=\${PIPESTATUS[0]}
printf '%s\n' "$__rc" > "$__exit_code_file"
if [ -n "\${SHELL:-}" ] && [ -x "\${SHELL:-}" ]; then
  exec "$SHELL" -l
fi
exec bash -l
`,
    { mode: 0o755 },
  );

  return { id, scriptPath };
};

type CreateBashWindowInput = {
  runDir: string;
  session: string;
  gitRoot: string;
  piSessionId: string;
  command: string;
  name?: string;
  sessionExists: boolean;
  options: ResolvedOptions;
};

const tagBashWindow = (
  input: CreateBashWindowInput,
  displayCommand: string,
  scriptId: string,
  windowId: string,
): RunWindowResult => {
  const outputFile = outputFileForRun(input.runDir, {
    session: input.session,
    windowId,
    id: scriptId,
  });
  setWindowOptions(
    windowId,
    {
      [TMUX_WINDOW_OPTIONS.gitRoot]: input.gitRoot,
      [TMUX_WINDOW_OPTIONS.piSessionId]: input.piSessionId,
      [TMUX_WINDOW_OPTIONS.startedAt]: String(Math.floor(Date.now() / 1000)),
      [TMUX_WINDOW_OPTIONS.outputFile]: outputFile,
      [TMUX_WINDOW_OPTIONS.displayCommand]: displayCommand,
    },
    input.options,
  );

  return { windowId, id: scriptId, outputFile };
};

const createBashWindow = (input: CreateBashWindowInput): RunWindowResult => {
  const displayCommand = displayCommandForCommand(
    input.command,
    input.options.displayCommandStartMarker,
  );
  const script = createBashCommandScript(
    input.runDir,
    input.session,
    input.command,
    displayCommand,
    input.options,
  );
  const createCommand = input.sessionExists
    ? `new-window -d -t ${shellQuote(input.session)}`
    : `new-session -d -s ${shellQuote(input.session)}`;
  const windowId = exec(
    `${tmuxCommand(input.options)} ${createCommand} -n ${shellQuote(tmuxWindowNameForCommand(input.command, input.name, input.options))} -c ${shellQuote(input.gitRoot)} -P -F '#{window_id}' ${shellQuote(script.scriptPath)}`,
  );
  return tagBashWindow(input, displayCommand, script.id, windowId);
};

const waitForExitCode = async (
  runDir: string,
  signal: AbortSignal | undefined,
  commandRun: CommandRunInfo,
  timeoutSeconds: number,
): Promise<number | "timeout" | "aborted"> => {
  const exitCodeFile = join(runDir, exitCodeFilename(commandRun));
  const deadline = Date.now() + timeoutSeconds * 1000;

  for (;;) {
    if (signal?.aborted) return "aborted";
    if (existsSync(exitCodeFile)) {
      const exitCode = parseInt(readFileSync(exitCodeFile, "utf-8").trim());
      unlinkSync(exitCodeFile);
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
  formatOutput(bashWindowOutput(window), {
    fullOutputPath: window.outputFile,
    truncationOptions: {
      maxLines: contextLines,
      maxBytes: options.maxOutputBytes,
    },
  });

const bashWindowDisplayLines = (
  window: TmuxWindow,
  expanded: boolean,
  options: ResolvedOptions,
  contextLines: number,
  compactDisplayLines: number,
  expandedDisplayLines: number,
  truncatedCompactDisplayLines: number,
): string[] => {
  const output = formatBashWindowOutput(window, options, contextLines);
  return [
    `$ ${window.displayCommand ?? window.title}`,
    ...formatRenderedBashResult(output.details.render, {
      expanded,
      compactDisplayLines,
      expandedDisplayLines,
      truncatedCompactDisplayLines,
    }).split("\n"),
  ];
};

const pollerKey = (session: string, windowId: string): string => `${session}:${windowId}`;

const readExitCodeFile = (
  state: ExtensionState,
  commandRun?: CommandRunInfo,
): number | undefined => {
  if (!commandRun || !state.runDir) return undefined;

  const filename = exitCodeFilename(commandRun);
  const exitCodeFile = join(state.runDir, filename);
  if (!existsSync(exitCodeFile)) return undefined;

  const exitCode = parseInt(readFileSync(exitCodeFile, "utf-8").trim());
  unlinkSync(exitCodeFile);
  state.foregroundExitCodeFiles.delete(filename);
  state.ownedExitCodeFiles.delete(filename);
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

const runningProcessListFormat = [
  "#{pane_current_command}",
  "#{pane_pid}",
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.gitRoot),
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.piSessionId),
  tmuxFormatOption(TMUX_WINDOW_OPTIONS.outputFile),
].join("|||");

const countRunningBackgroundProcesses = (
  session: string,
  filters: TmuxWindowFilters,
  options: ResolvedOptions,
): number => {
  const raw = execSafe(
    `${tmuxCommand(options)} list-windows -t ${shellQuote(session)} -F ${shellQuote(runningProcessListFormat)}`,
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

export const updateBackgroundProcessStatus = (
  ctx: ExtensionContext,
  options: ResolvedOptions,
): void => {
  if (!ctx.hasUI) return;

  const gitRoot = getGitRoot(ctx.cwd);
  if (!gitRoot) {
    ctx.ui.setStatus(BACKGROUND_BASH_STATUS_KEY, undefined);
    return;
  }

  const session = calcTmuxSessionName(gitRoot, options);
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
  gitRoot,
  piSessionId,
  interval,
  lines,
}: Poller): PollerDetails => ({
  session,
  windowId,
  gitRoot,
  piSessionId,
  interval,
  lines,
});

type CustomMessageInput = Parameters<ExtensionAPI["sendMessage"]>[0];

const pollMessageDetails = (
  window: TmuxWindow,
  output: FormattedOutput,
  options: ResolvedOptions,
): PollMessageRenderDetails => ({
  summary: `tmux poll: ${window.title} ${window.id}`,
  command: `$ ${window.displayCommand ?? window.title}`,
  output: output.details.render,
  attachLines: [
    indentDisplayLine(tmuxWindowAttachHint(window.id, process.env, options.tmuxBinary)),
  ],
});

const formatPollMessage = (details: PollMessageRenderDetails): string =>
  [
    details.summary,
    indentDisplayLine(details.command),
    ...indentDisplayLines(formatRenderedBashResult(details.output, { expanded: true }).split("\n")),
    "",
    ...details.attachLines,
  ].join("\n");

const pollCustomMessage = (
  window: TmuxWindow,
  output: FormattedOutput,
  options: ResolvedOptions,
): CustomMessageInput => {
  const details = pollMessageDetails(window, output, options);
  return {
    customType: "tmux-bash-poll",
    content: formatPollMessage(details),
    details,
    display: true,
  };
};

const completionMessageDetails = (
  exitCode: number,
  output: FormattedOutput,
): CompletionMessageRenderDetails => ({
  summary: formatCompletionSummary(exitCode),
  output: output.details.render,
  exitCode,
  status: exitCode === 0 ? "success" : "failed",
});

const formatCompletionMessage = (details: CompletionMessageRenderDetails): string => {
  if (hasOnlyEmptyBashOutput(details.output)) return details.summary;

  return `${details.summary}\n\n\`\`\`\n${formatRenderedBashResult(details.output, { expanded: true })}\n\`\`\``;
};

const completionCustomMessage = (exitCode: number, output: FormattedOutput): CustomMessageInput => {
  const details = completionMessageDetails(exitCode, output);
  return {
    customType: "tmux-bash-completion",
    content: formatCompletionMessage(details),
    details,
    display: true,
  };
};

const effectivePollInterval = (interval: number, options: ResolvedOptions): number =>
  options.pollDelivery === "model"
    ? Math.max(interval, options.minimumPollIntervalSeconds)
    : interval;

// Display-only polls wait for an idle UI so they don't interrupt the user's active turn.
const sendPollMessageWhenIdle = (
  pi: ExtensionAPI,
  state: ExtensionState,
  message: CustomMessageInput,
): void => {
  if (state.statusContext?.isIdle?.() !== false) {
    pi.sendMessage(message, { triggerTurn: false });
    return;
  }

  const timer = setTimeout(() => {
    state.pendingPollMessageTimers.delete(timer);
    sendPollMessageWhenIdle(pi, state, message);
  }, 100);
  state.pendingPollMessageTimers.add(timer);
};

const startPoller = (
  pi: ExtensionAPI,
  state: ExtensionState,
  session: string,
  windowId: string,
  interval: number,
  lines: number,
  options: ResolvedOptions,
  gitRoot: string,
  piSessionId: string,
  commandRun?: CommandRunInfo,
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

    const exitCode = readExitCodeFile(state, commandRun);
    const completed = exitCode !== undefined;
    const outputFile = commandRun?.outputFile ?? window.outputFile;
    const outputLines = completed ? options.completedContextLines : lines;
    const output = completed
      ? formatOutput(commandOutputTail(windowId, outputLines, options, outputFile), {
          fullOutputPath: outputFile,
          showFullOutputPath: options.alwaysShowOutputFilePath,
          truncationOptions: {
            maxLines: outputLines,
            maxBytes: options.maxOutputBytes,
          },
        })
      : formatBashWindowOutput(window, options, outputLines);
    if (!completed && options.pollDelivery === "display" && output.text === lastText) return;

    lastText = output.text;
    if (completed) stopPoller(state, session, windowId);

    const message = completed
      ? completionCustomMessage(exitCode, output)
      : pollCustomMessage(window, output, options);

    if (completed) {
      pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
    } else if (options.pollDelivery === "model") {
      pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
    } else {
      sendPollMessageWhenIdle(pi, state, message);
    }
    if (completed) {
      closeWindowOnCompletion(windowId, options);
      updateStoredBackgroundProcessStatus(state, options);
    }
  }, interval * 1000);

  state.pollers.set(pollerKey(session, windowId), {
    timer,
    session,
    windowId,
    gitRoot,
    piSessionId,
    interval,
    lines,
    commandRun,
  });
};

const handleCompletedExitCodeFile = (
  state: ExtensionState,
  pi: ExtensionAPI,
  exitCodeFilePath: string,
  filename: string,
  options: ResolvedOptions,
): boolean => {
  const parsed = parseExitCodeFilename(filename);
  if (!parsed) return false;

  const exitCode = readFileSync(exitCodeFilePath, "utf-8").trim();
  if (!/^-?\d+$/.test(exitCode)) return false;
  unlinkSync(exitCodeFilePath);

  const outputFile = `${exitCodeFilePath}.out`;
  const fileOutput = readOutputFile(outputFile);
  const rawOutput =
    fileOutput ??
    execSafe(
      `${tmuxCommand(options)} capture-pane -t ${shellQuote(parsed.windowId)} -p -S -${options.completedContextLines}`,
    );
  const output = formatOutput(rawOutput ?? "", {
    fullOutputPath: fileOutput === null ? undefined : outputFile,
    showFullOutputPath: options.alwaysShowOutputFilePath,
    truncationOptions: {
      maxLines: options.completedContextLines,
      maxBytes: options.maxOutputBytes,
    },
  });
  const code = parseInt(exitCode);
  stopPoller(state, parsed.session, parsed.windowId);

  pi.sendMessage(completionCustomMessage(code, output), {
    triggerTurn: true,
    deliverAs: "followUp",
  });
  closeWindowOnCompletion(parsed.windowId, options);
  updateStoredBackgroundProcessStatus(state, options);
  return true;
};

const handleExitCodeFile = (
  state: ExtensionState,
  pi: ExtensionAPI,
  runDir: string,
  filename: string,
  options: ResolvedOptions,
): void => {
  if (!state.ownedExitCodeFiles.has(filename)) return;
  if (state.foregroundExitCodeFiles.has(filename)) return;

  const exitCodeFilePath = join(runDir, filename);
  if (!existsSync(exitCodeFilePath)) return;

  try {
    if (handleCompletedExitCodeFile(state, pi, exitCodeFilePath, filename, options)) {
      state.ownedExitCodeFiles.delete(filename);
    }
  } catch {}
};

const startWatching = (state: ExtensionState, pi: ExtensionAPI, options: ResolvedOptions): void => {
  if (state.watcher) return;

  const runDir = getRunDir(state, options);
  state.watcher = watch(runDir, (_eventType, filename) => {
    if (!filename || filename.endsWith(".sh") || filename.endsWith(".out")) return;
    setTimeout(() => handleExitCodeFile(state, pi, runDir, filename.toString(), options), 100);
  });
};

const cleanupRunDir = (runDir: string, preserveOutputFiles: boolean): void => {
  if (!existsSync(runDir)) return;
  if (!preserveOutputFiles) {
    rmSync(runDir, { recursive: true, force: true });
    return;
  }

  readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => !entry.isFile() || !entry.name.endsWith(".out"))
    .forEach((entry) => rmSync(join(runDir, entry.name), { recursive: true, force: true }));
};

export const cleanupState = (state: ExtensionState, options: ResolvedOptions): void => {
  state.watcher?.close();
  state.watcher = null;
  for (const poller of state.pollers.values()) clearInterval(poller.timer);
  state.pollers.clear();
  for (const timer of state.pendingPollMessageTimers.values()) clearTimeout(timer);
  state.pendingPollMessageTimers.clear();
  state.foregroundExitCodeFiles.clear();
  state.ownedExitCodeFiles.clear();
  state.statusContext = null;

  if (state.runDir) {
    cleanupRunDir(state.runDir, options.preserveOutputFiles);
    state.runDir = null;
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

const summaryToolText = (summary: string, details: Record<string, unknown> = {}) =>
  renderedToolText(summary, { summary, expandedLines: [], collapsedLines: [] }, details);

export const toolError = (text: string) => ({
  ...summaryToolText(text),
  isError: true,
});

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

const compactPeekContextLine = (line: string): string =>
  line.replace(/^\.\.\. \((\d+) earlier lines,.*to expand\)$/, "... ($1 earlier lines omitted)");

const peekWindowContextLines = (window: TmuxWindow, options: ResolvedOptions): string[] => [
  `tmux window: ${window.title} ${window.id}`,
  ...bashWindowDisplayLines(
    window,
    false,
    options,
    options.peekContextLines,
    options.peekCompactDisplayLines,
    options.peekExpandedDisplayLines,
    options.peekTruncatedCompactDisplayLines,
  ).map(compactPeekContextLine),
];

const renderPeekDetails = (window: TmuxWindow, options: ResolvedOptions): TmuxRenderDetails => ({
  summary: `tmux window: ${window.title} ${window.id}`,
  expandedLines: peekWindowExpandedLines(window, options),
  collapsedLines: peekWindowCollapsedLines(window, options),
  attachLines: [
    "",
    indentDisplayLine(tmuxWindowAttachHint(window.id, process.env, options.tmuxBinary)),
  ],
});

const isTmuxWindowId = (window: string): boolean => /^@\d+$/.test(window);

const findBashWindowById = (
  session: string,
  filters: TmuxWindowFilters,
  options: ResolvedOptions,
  windowId: string,
): TmuxWindow | undefined =>
  getBashCreatedWindows(session, options, filters).find((item) => item.id === windowId);

const requireBashWindowById = (
  action: string,
  session: string,
  filters: TmuxWindowFilters,
  options: ResolvedOptions,
  windowId: string,
) => {
  if (!isTmuxWindowId(windowId)) {
    return toolError(`Error: ${action} requires a tmux #{window_id}, e.g. @123.`);
  }

  const window = findBashWindowById(session, filters, options, windowId);
  if (!window) return toolError(`No bash-created tmux window ${windowId} in session ${session}.`);
  return window;
};

const peekAction = (
  params: Extract<TmuxInput, { action: "peek" }>,
  session: string,
  filters: TmuxWindowFilters,
  options: ResolvedOptions,
) => {
  if (!sessionExists(session, options.tmuxBinary))
    return toolError(`No background session '${session}'.`);

  const window = requireBashWindowById("peek", session, filters, options, params.window);
  if ("isError" in window) return window;

  const output = peekWindowContextLines(window, options).join("\n");
  const render = renderPeekDetails(window, options);
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
    { summary, expandedLines: ["", ...lines], collapsedLines: ["", ...lines] },
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

  const window = requireBashWindowById("kill", session, filters, options, params.window);
  if ("isError" in window) return window;

  exec(`${tmuxCommand(options)} kill-window -t ${shellQuote(params.window)}`);
  stopPoller(state, session, window.id);
  return summaryToolText(`Killed background tmux window: ${window.title} ${window.id}.`);
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
  const window = requireBashWindowById("poll", session, filters, options, params.window);
  if ("isError" in window) return window;

  if (params.pollInterval <= 0)
    return toolError("Error: pollInterval must be greater than 0 for poll action.");

  const pollInterval = effectivePollInterval(params.pollInterval, options);
  startPoller(
    pi,
    state,
    session,
    window.id,
    pollInterval,
    params.pollLines,
    options,
    gitRoot,
    piSessionId,
  );
  return summaryToolText(`Polling ${window.title} every ${pollInterval}s.`);
};

const unpollAction = (
  params: Extract<TmuxInput, { action: "unpoll" }>,
  session: string,
  filters: TmuxWindowFilters,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const window = requireBashWindowById("unpoll", session, filters, options, params.window);
  if ("isError" in window) return window;

  return summaryToolText(
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
  if (pollers.length === 0) return summaryToolText("No active pollers.");

  const details = pollers.map(pollerDetails);
  const windows = getBashCreatedWindows(session, options, filters);
  const lines = details.map((poller) => {
    const title = windows.find((window) => window.id === poller.windowId)?.title ?? poller.windowId;
    return `  ${title} every ${poller.interval}s (${poller.lines} lines)`;
  });
  return renderedToolText(
    `Active pollers:\n\n${lines.join("\n")}`,
    { summary: "Active pollers:", expandedLines: ["", ...lines], collapsedLines: ["", ...lines] },
    { pollers: details },
  );
};

export const executeTool = (
  params: TmuxInput,
  ctx: ExtensionContext,
  state: ExtensionState,
  pi: ExtensionAPI,
  options: ResolvedOptions,
) => {
  const gitRoot = getGitRoot(ctx.cwd);
  if (!gitRoot) return toolError("Error: not in a git repository.");

  const piSessionId = ctx.sessionManager.getSessionId();
  const session = calcTmuxSessionName(gitRoot, options);
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

const bashPollInterval = (params: BashInput): number =>
  "pollInterval" in params ? (params.pollInterval ?? 0) : 0;

const bashPollLines = (params: BashInput, options: ResolvedOptions): number =>
  "pollLines" in params ? (params.pollLines ?? options.pollContextLines) : options.pollContextLines;

const timeoutBackgroundHint = (options: ResolvedOptions): string => {
  const actions = (["peek", "list", "kill"] as TmuxAction[]).filter((action) =>
    options.tmuxEnabledActions.includes(action),
  );
  if (actions.length === 0) return "Result will be reported when it finishes.";

  return `Use ${options.tmuxToolName} ${actions.join("/")} to inspect or stop it. Result will be reported when it finishes.`;
};

export const runBashInTmux = async (
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
  const session = calcTmuxSessionName(gitRoot, options);
  const piSessionId = ctx.sessionManager.getSessionId();
  const runDir = getRunDir(state, options);
  const result = createBashWindow({
    runDir,
    session,
    gitRoot,
    piSessionId,
    command: params.command,
    name: params.name,
    sessionExists: sessionExists(session, options.tmuxBinary),
    options,
  });
  const commandRun = {
    session,
    windowId: result.windowId,
    id: result.id,
    outputFile: result.outputFile,
  };
  const completionExitCodeFilename = exitCodeFilename(commandRun);
  state.ownedExitCodeFiles.add(completionExitCodeFilename);

  updateBackgroundProcessStatus(ctx, options);

  if (params.background === true) {
    const requestedPollInterval = bashPollInterval(params);
    const pollInterval = effectivePollInterval(requestedPollInterval, options);
    if (requestedPollInterval > 0)
      startPoller(
        pi,
        state,
        session,
        result.windowId,
        pollInterval,
        bashPollLines(params, options),
        options,
        gitRoot,
        piSessionId,
        commandRun,
      );
    return {
      content: [
        {
          type: "text" as const,
          text: `Started in background tmux window: ${tmuxWindowNameForCommand(params.command, params.name, options)} ${result.windowId}.${requestedPollInterval > 0 ? ` Polling every ${pollInterval}s.` : ""}\nResult will be reported when it finishes.\n\n${tmuxWindowAttachHint(result.windowId, process.env, options.tmuxBinary)}`,
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
  state.foregroundExitCodeFiles.add(completionExitCodeFilename);
  const exitCode = await waitForExitCode(runDir, signal, commandRun, params.timeout).finally(() => {
    stopForegroundUpdates();
    state.foregroundExitCodeFiles.delete(completionExitCodeFilename);
  });
  if (exitCode !== "timeout" || params.timeoutAction !== "background") {
    state.ownedExitCodeFiles.delete(completionExitCodeFilename);
  }
  const output = formatOutput(
    commandOutputTail(result.windowId, options.bashContextLines, options, result.outputFile),
    {
      fullOutputPath: result.outputFile,
      showFullOutputPath: options.alwaysShowOutputFilePath,
      truncationOptions: {
        maxLines: options.bashContextLines,
        maxBytes: options.maxOutputBytes,
      },
    },
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

    const requestedPollInterval = bashPollInterval(params);
    const pollInterval = effectivePollInterval(requestedPollInterval, options);
    if (requestedPollInterval > 0)
      startPoller(
        pi,
        state,
        session,
        result.windowId,
        pollInterval,
        bashPollLines(params, options),
        options,
        gitRoot,
        piSessionId,
        commandRun,
      );
    const timeoutText = `Still running after ${params.timeout}s in background tmux${requestedPollInterval > 0 ? ` and polling every ${pollInterval}s` : ""}. ${timeoutBackgroundHint(options)}`;
    return {
      content: [
        {
          type: "text" as const,
          text: [text, timeoutText].filter(Boolean).join("\n\n"),
        },
      ],
      details: { ...output.details, outcome: "timed-out-background" as const },
    };
  }

  closeWindowOnCompletion(result.windowId, options);
  updateBackgroundProcessStatus(ctx, options);

  if (exitCode !== 0) {
    throw new Error(`${text}\n\nCommand exited with code ${exitCode}`);
  }

  return {
    content: [{ type: "text" as const, text }],
    details: output.details,
  };
};
