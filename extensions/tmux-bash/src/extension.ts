import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type BashToolDetails,
  type BashToolInput,
  type ExtensionAPI,
  type ExtensionContext,
  type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  attachToSession,
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

const SIGNAL_BASE = "/tmp/pi-tmux-bash";

const actionValues = ["attach", "peek", "list", "kill", "poll", "unpoll", "list-polls"] as const;
type TmuxAction = (typeof actionValues)[number];

const BashBaseParams = Type.Object({
  command: Type.String({ description: "Bash command to run in a background tmux window." }),
  name: Type.Optional(Type.String({ description: "Optional tmux window name." })),
});

const BashTimeoutParams = Type.Object({
  timeout: Type.Optional(
    Type.Number({
      description:
        "Seconds to wait before applying timeoutAction. Defaults/clamps according to extension config.",
    }),
  ),
});

const PollParams = Type.Object({
  pollInterval: Type.Optional(
    Type.Number({ description: "Seconds between automatic output check-ins." }),
  ),
  pollLines: Type.Optional(Type.Number({ description: "Scrollback lines captured per poll." })),
});

const BashInTmuxParams = Type.Union(
  [
    Type.Intersect([
      BashBaseParams,
      PollParams,
      Type.Object({
        background: Type.Literal(true, {
          description: "Return immediately after starting the command in tmux.",
        }),
      }),
    ]),
    Type.Intersect([
      BashBaseParams,
      BashTimeoutParams,
      PollParams,
      Type.Object({
        background: Type.Optional(Type.Literal(false)),
        timeoutAction: Type.Literal("background", {
          description: "Leave the command running in tmux if the timeout is reached.",
        }),
      }),
    ]),
    Type.Intersect([
      BashBaseParams,
      BashTimeoutParams,
      Type.Object({
        background: Type.Optional(Type.Literal(false)),
        timeoutAction: Type.Optional(
          Type.Literal("kill", {
            description: "Kill the tmux window if the timeout is reached.",
          }),
        ),
      }),
    ]),
  ],
  { type: "object" },
);

const WindowParam = Type.Union([Type.Number(), Type.String()]);
const PeekWindowParam = Type.Union([Type.Literal("all"), Type.Number(), Type.String()]);

const TmuxParams = Type.Union(
  [
    Type.Object({ action: Type.Literal("list") }),
    Type.Object({ action: Type.Literal("kill") }),
    Type.Object({ action: Type.Literal("list-polls") }),
    Type.Object({
      action: Type.Literal("attach"),
      window: Type.Optional(WindowParam),
    }),
    Type.Object({
      action: Type.Literal("peek"),
      window: Type.Optional(PeekWindowParam),
    }),
    Type.Intersect([
      PollParams,
      Type.Object({
        action: Type.Literal("poll"),
        window: WindowParam,
      }),
    ]),
    Type.Object({
      action: Type.Literal("unpoll"),
      window: WindowParam,
    }),
  ],
  { type: "object" },
);

type TmuxInput = {
  action: TmuxAction;
  window?: number | string;
  pollInterval?: number;
  pollLines?: number;
};

export type TmuxBashOptions = {
  sessionNameTemplate?: string;
  toolName?: string;
  commandPrefix?: string;
  captureLines?: number;
  completionCaptureLines?: number;
  completionTailLines?: number;
  windowNameTemplate?: string;
  maxWindowNameLength?: number;
  autoKillIdleOnStartup?: boolean;
  killSessionOnShutdown?: boolean;
  replaceBashTool?: boolean;
  defaultTimeoutSeconds?: number;
  maxTimeoutSeconds?: number;
  defaultPollInterval?: number;
  defaultPollLines?: number;
  prompt?: string;
};

type ResolvedOptions = Required<TmuxBashOptions>;
type TimeoutAction = "kill" | "background";
type BashExecutionMode = "foreground" | "background" | "background-on-timeout";
type BashInTmuxInput = BashToolInput & {
  timeoutAction?: TimeoutAction;
  name?: string;
  background?: boolean;
  pollInterval?: number;
  pollLines?: number;
};
type ResolvedBashCall = {
  mode: BashExecutionMode;
  timeout: number;
  timeoutAction: TimeoutAction;
  pollInterval: number;
  pollLines: number;
};
type ResolvedPollCall = { interval: number; lines: number };
type SignalInfo = { session: string; winIdx: number; id: string; outputFile?: string };
type Poller = {
  timer: NodeJS.Timeout;
  session: string;
  windowIndex: number;
  interval: number;
  lines: number;
  signalInfo?: SignalInfo;
};

type ExtensionState = {
  signalDir: string | null;
  watcher: FSWatcher | null;
  bashSignals: Set<string>;
  pollers: Map<string, Poller>;
  activeSession: string | null;
};

type RunWindowResult = { index: number; id: string; outputFile?: string };
type FormattedOutput = { text: string; details: BashToolDetails | undefined };

export const DEFAULT_OPTIONS: ResolvedOptions = {
  sessionNameTemplate: DEFAULT_SESSION_NAME_TEMPLATE,
  toolName: "tmux",
  commandPrefix: "tmux",
  captureLines: 50,
  completionCaptureLines: 30,
  completionTailLines: 20,
  windowNameTemplate: "{{nameOrCommand}}",
  maxWindowNameLength: 30,
  autoKillIdleOnStartup: false,
  killSessionOnShutdown: false,
  replaceBashTool: true,
  defaultTimeoutSeconds: 30,
  maxTimeoutSeconds: 60,
  defaultPollInterval: 0,
  defaultPollLines: 30,
  prompt: "",
};

const assertSessionNameTemplate = (template: string): string => {
  if (!template.includes("{{}}")) {
    throw new Error('sessionNameTemplate must include "{{}}" as the project session placeholder');
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
    sessionNameTemplate: assertSessionNameTemplate(
      input.sessionNameTemplate ?? DEFAULT_OPTIONS.sessionNameTemplate,
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
});

const getSignalDir = (state: ExtensionState): string => {
  if (state.signalDir) return state.signalDir;

  state.signalDir = join(SIGNAL_BASE, randomBytes(8).toString("hex"));
  mkdirSync(state.signalDir, { recursive: true });
  return state.signalDir;
};

const resetSignalDir = (state: ExtensionState, sessionFile?: string): void => {
  const id = sessionFile
    ? Buffer.from(sessionFile).toString("base64url").slice(0, 24)
    : randomBytes(8).toString("hex");
  state.signalDir = join(SIGNAL_BASE, id);
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

const parseSignalFilename = (filename: string): SignalInfo | null => {
  const lastDot = filename.lastIndexOf(".");
  const secondLastDot = filename.lastIndexOf(".", lastDot - 1);
  if (secondLastDot === -1) return null;

  const session = filename.slice(0, secondLastDot);
  const winIdx = parseInt(filename.slice(secondLastDot + 1, lastDot));
  if (Number.isNaN(winIdx)) return null;

  return { session, winIdx, id: filename.slice(lastDot + 1) };
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
): FormattedOutput => {
  const text = content || emptyText;
  const truncation = truncateTail(text);
  if (!truncation.truncated) return { text, details: undefined };

  return {
    text: `${truncation.content}\n\n${truncationNotice(text, truncation, fullOutputPath)}`,
    details: { truncation, fullOutputPath },
  };
};

const formatOutput = formatTmuxOutputForContext;

const formatTrimmedOutput = (content: string, fullOutputPath?: string): FormattedOutput =>
  formatOutput(content.trim(), fullOutputPath);

const outputFileForSignal = (signalDir: string, { session, winIdx, id }: SignalInfo): string =>
  join(signalDir, `${session}.${winIdx}.${id}.out`);

const readOutputFile = (outputFile: string | undefined): string | null => {
  if (!outputFile || !existsSync(outputFile)) return null;
  return readFileSync(outputFile, "utf-8");
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
__win_idx=$(tmux display-message -p -t "\${TMUX_PANE:-}" '#{window_index}' 2>/dev/null || printf '0')
__signal_file="$__signal_dir/$__session.$__win_idx.$__id"
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

const addBashWindow = (
  signalDir: string,
  session: string,
  gitRoot: string,
  cmd: string,
  name: string | undefined,
  options: ResolvedOptions,
): RunWindowResult => {
  const script = createBashCommandScript(signalDir, session, cmd);
  const raw = exec(
    `tmux new-window -d -t ${shellQuote(session)} -n ${shellQuote(windowNameForCommand(cmd, name, options))} -c ${shellQuote(gitRoot)} -P -F '#{window_index}' ${shellQuote(script.scriptPath)}`,
  );
  const index = parseInt(raw);
  return {
    index,
    id: script.id,
    outputFile: outputFileForSignal(signalDir, { session, winIdx: index, id: script.id }),
  };
};

const createBashSessionWindow = (
  signalDir: string,
  session: string,
  gitRoot: string,
  cmd: string,
  name: string | undefined,
  options: ResolvedOptions,
): RunWindowResult => {
  const script = createBashCommandScript(signalDir, session, cmd);
  const raw = exec(
    `tmux new-session -d -s ${shellQuote(session)} -n ${shellQuote(windowNameForCommand(cmd, name, options))} -c ${shellQuote(gitRoot)} -P -F '#{window_index}' ${shellQuote(script.scriptPath)}`,
  );
  const index = parseInt(raw);
  return {
    index,
    id: script.id,
    outputFile: outputFileForSignal(signalDir, { session, winIdx: index, id: script.id }),
  };
};

const resolveWindowIndex = (window: TmuxInput["window"]): number | undefined | "invalid" => {
  if (window === undefined) return undefined;
  if (window === "all") return "invalid";

  const index = typeof window === "number" ? window : parseInt(window);
  return Number.isNaN(index) ? "invalid" : index;
};

const normalizeBashTimeout = (timeout: number | undefined, options: ResolvedOptions): number =>
  Math.min(
    positiveInteger("bash timeout", timeout ?? options.defaultTimeoutSeconds),
    options.maxTimeoutSeconds,
  );

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitForExitCode = async (
  signalDir: string,
  signal: AbortSignal | undefined,
  { session, winIdx, id }: SignalInfo,
  timeoutSeconds: number,
): Promise<number | "timeout" | "aborted"> => {
  const signalFile = join(signalDir, `${session}.${winIdx}.${id}`);
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

const captureWindowOutput = (session: string, windowIndex: number, lines: number): string =>
  execSafe(`tmux capture-pane -t ${shellQuote(`${session}:${windowIndex}`)} -p -S -${lines}`) ?? "";

const commandOutput = (
  session: string,
  windowIndex: number,
  lines: number,
  outputFile?: string,
): string => readOutputFile(outputFile) ?? captureWindowOutput(session, windowIndex, lines);

const pollerKey = (session: string, windowIndex: number): string => `${session}:${windowIndex}`;

const resolvePollInterval = (params: { pollInterval?: number }, options: ResolvedOptions): number =>
  nonNegativeInteger("pollInterval", params.pollInterval ?? options.defaultPollInterval);

const resolvePollLines = (params: { pollLines?: number }, options: ResolvedOptions): number =>
  positiveInteger("pollLines", params.pollLines ?? options.defaultPollLines);

const resolvePollCall = (
  params: { pollInterval?: number; pollLines?: number },
  options: ResolvedOptions,
): ResolvedPollCall => ({
  interval: resolvePollInterval(params, options),
  lines: resolvePollLines(params, options),
});

const resolveBashMode = (params: BashInTmuxInput): BashExecutionMode => {
  if (params.background) return "background";
  if (params.timeoutAction === "background") return "background-on-timeout";
  return "foreground";
};

const resolveBashCall = (params: BashInTmuxInput, options: ResolvedOptions): ResolvedBashCall => {
  const mode = resolveBashMode(params);
  const canPoll = mode !== "foreground";

  return {
    mode,
    timeout: normalizeBashTimeout(params.timeout, options),
    timeoutAction: mode === "background-on-timeout" ? "background" : "kill",
    pollInterval: canPoll ? resolvePollInterval(params, options) : 0,
    pollLines: canPoll ? resolvePollLines(params, options) : options.defaultPollLines,
  };
};

const readSignalExitCode = (state: ExtensionState, signalInfo?: SignalInfo): number | undefined => {
  if (!signalInfo || !state.signalDir) return undefined;

  const filename = `${signalInfo.session}.${signalInfo.winIdx}.${signalInfo.id}`;
  const signalFile = join(state.signalDir, filename);
  if (!existsSync(signalFile)) return undefined;

  const exitCode = parseInt(readFileSync(signalFile, "utf-8").trim());
  unlinkSync(signalFile);
  state.bashSignals.delete(filename);
  return exitCode;
};

const stopPoller = (state: ExtensionState, session: string, windowIndex: number): boolean => {
  const key = pollerKey(session, windowIndex);
  const poller = state.pollers.get(key);
  if (!poller) return false;

  clearInterval(poller.timer);
  state.pollers.delete(key);
  return true;
};

const startPoller = (
  pi: ExtensionAPI,
  state: ExtensionState,
  session: string,
  windowIndex: number,
  interval: number,
  lines: number,
  signalInfo?: SignalInfo,
): void => {
  if (interval <= 0) return;

  stopPoller(state, session, windowIndex);
  const timer = setInterval(() => {
    const window = getWindows(session).find((item) => item.index === windowIndex);
    if (!window) {
      stopPoller(state, session, windowIndex);
      return;
    }

    const output = formatTrimmedOutput(
      commandOutput(session, windowIndex, lines, signalInfo?.outputFile),
      signalInfo?.outputFile,
    ).text;
    const exitCode = readSignalExitCode(state, signalInfo);
    const completed = exitCode !== undefined;
    if (completed) stopPoller(state, session, windowIndex);

    pi.sendMessage(
      {
        customType: completed ? "tmux-bash-completion" : "tmux-bash-poll",
        content: completed
          ? `tmux window "${window.title}" (:${windowIndex}) ${exitCode === 0 ? "completed successfully" : `exited with code ${exitCode}`}.

\`\`\`\n${output}\n\`\`\``
          : `tmux window "${window.title}" (:${windowIndex}) poll.

\`\`\`\n${output}\n\`\`\``,
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }, interval * 1000);

  state.pollers.set(pollerKey(session, windowIndex), {
    timer,
    session,
    windowIndex,
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

  const win = getWindows(parsed.session).find((item) => item.index === parsed.winIdx);
  const winName = win?.title ?? `window ${parsed.winIdx}`;
  const outputFile = `${filepath}.out`;
  const fileOutput = readOutputFile(outputFile);
  const rawOutput =
    fileOutput ??
    execSafe(
      `tmux capture-pane -t ${shellQuote(`${parsed.session}:${parsed.winIdx}`)} -p -S -${options.completionCaptureLines}`,
    );
  const output = formatOutput(
    trimOutput(rawOutput, options.completionTailLines),
    fileOutput === null ? undefined : outputFile,
  ).text;
  const code = parseInt(exitCode);
  const status = code === 0 ? "completed successfully" : `exited with code ${code}`;

  pi.sendMessage(
    {
      customType: "tmux-bash-completion",
      content: `tmux window "${winName}" (:${parsed.winIdx}) ${status}.\n\n\`\`\`\n${output}\n\`\`\``,
      display: true,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
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

  const signalDir = getSignalDir(state);
  state.watcher = watch(signalDir, (_eventType, filename) => {
    if (!filename || filename.endsWith(".sh") || filename.endsWith(".out")) return;
    setTimeout(() => handleSignalFile(state, pi, signalDir, filename.toString(), options), 100);
  });
};

const cleanupState = (state: ExtensionState): void => {
  state.watcher?.close();
  state.watcher = null;
  for (const poller of state.pollers.values()) clearInterval(poller.timer);
  state.pollers.clear();
  state.bashSignals.clear();

  if (state.signalDir) {
    rmSync(state.signalDir, { recursive: true, force: true });
    state.signalDir = null;
  }
};

const toolText = (text: string, details: unknown = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const toolError = (text: string) => ({ ...toolText(text), isError: true });

const attachAction = (
  params: TmuxInput,
  ctx: ExtensionContext,
  session: string,
  options: ResolvedOptions,
) => {
  if (!sessionExists(session)) return toolError(`No background session '${session}' to attach to.`);

  const windowIndex = resolveWindowIndex(params.window);
  if (windowIndex === "invalid")
    return toolError("Error: 'window' must be a numeric index for attach action.");

  const msg = attachToSession(ctx.cwd, options.sessionNameTemplate, windowIndex);
  const failed = msg.startsWith("Failed") || msg.startsWith("No ");
  return {
    content: [{ type: "text" as const, text: msg }],
    details: { session, ...(windowIndex !== undefined ? { windowIndex } : {}) },
    ...(failed ? { isError: true } : {}),
  };
};

const peekAction = (params: TmuxInput, session: string, options: ResolvedOptions) => {
  if (!sessionExists(session)) return toolError(`No background session '${session}'.`);

  const windowIndex =
    params.window === undefined || params.window === "all"
      ? "all"
      : resolveWindowIndex(params.window);
  const target = windowIndex === "invalid" || windowIndex === undefined ? "all" : windowIndex;
  const output = formatOutput(capturePanes(session, target, options.captureLines));
  return {
    content: [{ type: "text" as const, text: output.text }],
    details: { session, ...output.details },
  };
};

const listAction = (session: string) => {
  if (!sessionExists(session)) return toolError(`No background session '${session}'.`);

  const windows = getWindows(session);
  const lines = formatWindowLines(windows);
  return {
    content: [
      {
        type: "text" as const,
        text: `Background session ${session} — ${windows.length} window(s)\n${lines.join("\n")}`,
      },
    ],
    details: { session, windows },
  };
};

const killAction = (session: string) => {
  if (!sessionExists(session)) return toolText(`No background session '${session}' to kill.`);

  exec(`tmux kill-session -t ${shellQuote(session)}`);
  return toolText(`Killed background session ${session}.`);
};

const pollAction = (
  params: TmuxInput,
  session: string,
  state: ExtensionState,
  pi: ExtensionAPI,
  options: ResolvedOptions,
) => {
  const windowIndex = resolveWindowIndex(params.window);
  if (windowIndex === undefined || windowIndex === "invalid") {
    return toolError("Error: 'window' (index) required for poll action.");
  }

  const window = getWindows(session).find((item) => item.index === windowIndex);
  if (!window) return toolError(`No tmux window :${windowIndex} in session ${session}.`);

  const poll = resolvePollCall(params, options);
  if (poll.interval <= 0)
    return toolError("Error: pollInterval must be greater than 0 for poll action.");

  startPoller(pi, state, session, windowIndex, poll.interval, poll.lines);
  return toolText(`Polling "${window.title}" (:${windowIndex}) every ${poll.interval}s.`);
};

const unpollAction = (params: TmuxInput, session: string, state: ExtensionState) => {
  const windowIndex = resolveWindowIndex(params.window);
  if (windowIndex === undefined || windowIndex === "invalid") {
    return toolError("Error: 'window' (index) required for unpoll action.");
  }

  return toolText(
    stopPoller(state, session, windowIndex)
      ? `Stopped polling tmux window :${windowIndex}.`
      : `No poller for tmux window :${windowIndex}.`,
  );
};

const listPollsAction = (session: string, state: ExtensionState) => {
  const pollers = [...state.pollers.values()].filter((poller) => poller.session === session);
  if (pollers.length === 0) return toolText("No active pollers.");

  return toolText(
    `Active pollers:\n${pollers
      .map((poller) => `  :${poller.windowIndex} every ${poller.interval}s (${poller.lines} lines)`)
      .join("\n")}`,
    { pollers },
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

  const session = backgroundSessionName(gitRoot, options.sessionNameTemplate);
  if (params.action === "attach") return attachAction(params, ctx, session, options);
  if (params.action === "peek") return peekAction(params, session, options);
  if (params.action === "list") return listAction(session);
  if (params.action === "kill") return killAction(session);
  if (params.action === "poll") return pollAction(params, session, state, pi, options);
  if (params.action === "unpoll") return unpollAction(params, session, state);
  if (params.action === "list-polls") return listPollsAction(session, state);

  return toolError(`Unknown action: ${params.action}`);
};

const runBashInTmux = async (
  params: BashInTmuxInput,
  signal: AbortSignal | undefined,
  _onUpdate:
    | ((result: {
        content: Array<{ type: "text"; text: string }>;
        details: BashToolDetails | undefined;
      }) => void)
    | undefined,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const gitRoot = getGitRoot(ctx.cwd);
  if (!gitRoot) return toolError("Error: not in a git repository.");

  startWatching(state, pi, options);
  const session = backgroundSessionName(gitRoot, options.sessionNameTemplate);
  const exists = sessionExists(session);
  const call = resolveBashCall(params, options);
  const signalDir = getSignalDir(state);
  const result = exists
    ? addBashWindow(signalDir, session, gitRoot, params.command, params.name, options)
    : createBashSessionWindow(signalDir, session, gitRoot, params.command, params.name, options);
  const signalInfo = {
    session,
    winIdx: result.index,
    id: result.id,
    outputFile: result.outputFile,
  };
  const signalFilename = `${session}.${result.index}.${result.id}`;

  state.activeSession = session;
  if (call.mode !== "background" || call.pollInterval > 0) state.bashSignals.add(signalFilename);

  if (call.mode === "background") {
    if (call.pollInterval > 0)
      startPoller(pi, state, session, result.index, call.pollInterval, call.pollLines, signalInfo);
    return {
      content: [
        {
          type: "text" as const,
          text: `Started in tmux window${call.pollInterval > 0 ? ` and polling every ${call.pollInterval}s` : ""}.`,
        },
      ],
      details: undefined,
    };
  }

  const exitCode = await waitForExitCode(signalDir, signal, signalInfo, call.timeout);
  state.bashSignals.delete(signalFilename);
  const output = formatTrimmedOutput(
    commandOutput(session, result.index, options.captureLines, result.outputFile),
    result.outputFile,
  );
  const text = output.text;
  if (exitCode === "aborted") {
    execSafe(`tmux kill-window -t ${shellQuote(`${session}:${result.index}`)}`);
    return {
      content: [{ type: "text" as const, text: `${text}\n\nCommand aborted` }],
      details: output.details,
      isError: true,
    };
  }

  if (exitCode === "timeout") {
    if (call.timeoutAction === "kill") {
      execSafe(`tmux kill-window -t ${shellQuote(`${session}:${result.index}`)}`);
      return {
        content: [
          {
            type: "text" as const,
            text: `${text}\n\nCommand timed out after ${call.timeout} seconds and tmux window :${result.index} was killed.`,
          },
        ],
        details: output.details,
        isError: true,
      };
    }

    if (call.pollInterval > 0)
      startPoller(pi, state, session, result.index, call.pollInterval, call.pollLines, signalInfo);
    return {
      content: [
        {
          type: "text" as const,
          text: `${text}\n\nCommand is still running after ${call.timeout} seconds in tmux window :${result.index}${call.pollInterval > 0 ? ` and polling every ${call.pollInterval}s` : ""}. Use ${options.toolName} peek/list/kill to inspect or stop it.`,
        },
      ],
      details: output.details,
    };
  }

  if (exitCode !== 0) {
    return {
      content: [{ type: "text" as const, text: `${text}\n\nCommand exited with code ${exitCode}` }],
      details: output.details,
      isError: true,
    };
  }

  return { content: [{ type: "text" as const, text }], details: output.details };
};

const clearIdleWindows = (session: string): number | "missing" => {
  const raw = execSafe(
    `tmux list-windows -t ${shellQuote(session)} -F '#{window_index}|||#{window_name}|||#{pane_current_command}|||#{pane_pid}'`,
  );
  if (!raw) return "missing";

  const idle = raw
    .split("\n")
    .map((line) => {
      const [index = "0", name = "", cmd = "", pid = ""] = line.split("|||");
      return { index: parseInt(index), name, cmd, pid };
    })
    .filter((window) => ["bash", "zsh", "sh", "fish", "dash"].includes(window.cmd))
    .filter((window) => !execSafe(`pgrep -P ${shellQuote(window.pid)}`));

  idle.forEach((window) =>
    execSafe(`tmux kill-window -t ${shellQuote(`${session}:${window.index}`)}`),
  );
  return idle.length;
};

const registerCommands = (pi: ExtensionAPI, options: ResolvedOptions): void => {
  pi.registerCommand(options.commandPrefix, {
    description: "Open a terminal tab attached to this project's background tmux session",
    handler: async (_args, ctx) => {
      const msg = attachToSession(ctx.cwd, options.sessionNameTemplate);
      ctx.ui.notify(
        msg,
        msg.startsWith("Failed") || msg.startsWith("No") || msg.startsWith("Not")
          ? "error"
          : "info",
      );
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

      const session = backgroundSessionName(gitRoot, options.sessionNameTemplate);
      if (!sessionExists(session)) {
        ctx.ui.notify("No background tmux session for this project.", "error");
        return;
      }

      const windows = getWindows(session);
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

      const output = formatOutput(capturePanes(session, target, options.captureLines));
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

      const session = backgroundSessionName(gitRoot, options.sessionNameTemplate);
      const count = clearIdleWindows(session);
      if (count === "missing") {
        ctx.ui.notify("No background tmux session for this project.", "error");
        return;
      }

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

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: `Execute a bash command in a background tmux window in the current working directory. Returns captured tmux output truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Timeout defaults to ${options.defaultTimeoutSeconds}s and is clamped to ${options.maxTimeoutSeconds}s. Use background to return immediately. Use pollInterval with background true or timeoutAction "background" for periodic check-ins. If timeoutAction is "background", the command keeps running in tmux after timeout. If timeoutAction is "kill" or omitted, the tmux window is killed on timeout.`,
    promptSnippet: `Execute bash commands in background tmux windows; output is truncated like Pi's built-in bash; default timeout ${options.defaultTimeoutSeconds}s, max timeout ${options.maxTimeoutSeconds}s. Use background or timeoutAction "background" for servers/watchers. Use pollInterval for background check-ins.`,
    promptGuidelines: [
      `Bash commands run in tmux. Bash timeout values default to ${options.defaultTimeoutSeconds}s and are clamped to ${options.maxTimeoutSeconds}s.`,
      "Use bash with background true or timeoutAction 'background' for servers, file watchers, REPLs, interactive prompts, background jobs, or commands expected to run longer than the timeout.",
      "Use pollInterval with background true or timeoutAction 'background' when a backgrounded command should check in periodically.",
      `Use ${options.toolName} peek/list/kill/poll/unpoll to inspect, poll, or stop bash commands that are left running in tmux.`,
      ...(options.prompt.trim() ? [options.prompt.trim()] : []),
    ],
    parameters: BashInTmuxParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runBashInTmux(params as BashInTmuxInput, signal, onUpdate, pi, ctx, state, options);
    },
    renderCall(args, theme) {
      const bashArgs = args as Partial<BashInTmuxInput>;
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
  pi.registerTool({
    name: options.toolName,
    label: options.toolName,
    description: `Manage a background tmux session for the current project (one sidecar session per git root).

WHEN TO USE: Use this to inspect or control commands that were started with bash background:true or timeoutAction:"background". Use bash, not tmux, to start commands.

Actions:
- attach: Open a terminal tab attached to the background session.
- peek: Capture recent output from background tmux windows. Use window param to target a specific window, or omit for all. Captured output is truncated to stay within model context.
- list: List background tmux windows.
- kill: Kill the background tmux session.
- poll: Start periodic output check-ins for a window.
- unpoll: Stop periodic output check-ins for a window.
- list-polls: List active pollers.`,
    promptSnippet:
      "Inspect and control the background tmux session used by bash background:true calls.",
    promptGuidelines: [
      "Use bash with background:true or timeoutAction:'background' to start long-running commands; use tmux to inspect or control them after they start.",
      "Use tmux poll/unpoll to start or stop periodic check-ins for an existing background window.",
      "The tmux tool uses a background sidecar session so agent-run windows do not clutter the user's normal tmux session.",
      ...(options.prompt.trim() ? [options.prompt.trim()] : []),
    ],
    parameters: TmuxParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeTool(params as TmuxInput, ctx, state, pi, options);
    },
    renderCall(args, theme) {
      const tmuxArgs = args as Partial<TmuxInput>;
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

const registerRenderers = (pi: ExtensionAPI, options: ResolvedOptions): void => {
  pi.registerMessageRenderer("tmux-bash-completion", (message, { expanded }, theme) => {
    const [summary = "", ...detail] = String(message.content).split("\n");
    const icon = summary.includes("successfully")
      ? theme.fg("success", "✓")
      : theme.fg("error", "✗");
    return new Text(
      `${icon} ${theme.fg("toolTitle", options.toolName)} ${summary}${expanded && detail.length > 0 ? `\n${theme.fg("dim", detail.join("\n"))}` : ""}`,
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
      resetSignalDir(state, ctx.sessionManager.getSessionFile() ?? undefined);
      const gitRoot = getGitRoot(ctx.cwd);
      state.activeSession = gitRoot
        ? backgroundSessionName(gitRoot, options.sessionNameTemplate)
        : null;
      if (state.activeSession && options.autoKillIdleOnStartup)
        clearIdleWindows(state.activeSession);
    });

    pi.on("session_shutdown", async () => {
      if (state.activeSession && options.killSessionOnShutdown) {
        execSafe(`tmux kill-session -t ${shellQuote(state.activeSession)}`);
      }
      cleanupState(state);
    });

    registerCommands(pi, options);
    registerBashTool(pi, state, options);
    registerTool(pi, state, options);
    registerRenderers(pi, options);
  };
};
