import {
  backgroundSessionName,
  execSafe,
  getGitRoot,
  getWindows,
  shellQuote,
  type TmuxWindow,
  type TmuxWindowFilters,
} from "./tmux-utils.js";
import type { ResolvedOptions } from "./extension.js";

export type { TmuxWindow, TmuxWindowFilters } from "./tmux-utils.js";

export type TmuxBashContext = {
  gitRoot: string;
  session: string;
  filters: TmuxWindowFilters;
};

type ResolveTmuxBashContextInput = {
  cwd: string;
  piSessionId: string;
  options: ResolvedOptions;
};

type IdleWindow = {
  index: number;
  cmd: string;
  pid: string;
  gitRoot: string;
  piSessionId: string;
  outputFile: string;
};

const shellCommands = new Set(["bash", "zsh", "sh", "fish", "dash"]);

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

const matchesFilters = (window: IdleWindow, filters: TmuxWindowFilters): boolean =>
  (filters.gitRoot === undefined || window.gitRoot === filters.gitRoot) &&
  (filters.piSessionId === undefined || window.piSessionId === filters.piSessionId);

const parseIdleWindow = (line: string): IdleWindow => {
  const [index = "0", , cmd = "", pid = "", windowGitRoot = "", piSessionId = "", outputFile = ""] =
    line.split("|||");
  return {
    index: parseInt(index),
    cmd,
    pid,
    gitRoot: windowGitRoot,
    piSessionId,
    outputFile,
  };
};

const hasChildProcesses = (pid: string): boolean =>
  Boolean(pid && execSafe(`pgrep -P ${shellQuote(pid)} | head -1`));

const isIdleShell = (window: IdleWindow): boolean =>
  Boolean(window.outputFile) && shellCommands.has(window.cmd) && !hasChildProcesses(window.pid);

const getIdleWindows = (context: TmuxBashContext): IdleWindow[] | "missing" => {
  const raw = execSafe(
    `tmux list-windows -t ${shellQuote(context.session)} -F '#{window_index}|||#{window_name}|||#{pane_current_command}|||#{pane_pid}|||#{@pi-tmux-bash-git-root}|||#{@pi-tmux-bash-pi-session-id}|||#{@pi-tmux-bash-output-file}'`,
  );
  if (!raw) return "missing";

  return raw
    .split("\n")
    .map(parseIdleWindow)
    .filter((window) => matchesFilters(window, context.filters))
    .filter(isIdleShell);
};

// Example:
// const options = loadTmuxBashConfig();
// const context = resolveTmuxBashContext({
//   cwd: ctx.cwd,
//   piSessionId: ctx.sessionManager.getSessionId(),
//   options,
// });
// if (!context) ctx.ui.notify("Not in a git repository.", "error");
//
// Resolves:
// - current git root
// - tmux session name from config
// - window filters from config
export const resolveTmuxBashContext = ({
  cwd,
  piSessionId,
  options,
}: ResolveTmuxBashContextInput): TmuxBashContext | null => {
  const gitRoot = getGitRoot(cwd);
  if (!gitRoot) return null;

  return {
    gitRoot,
    session: tmuxSessionNameForGitRoot(gitRoot, options),
    filters: tmuxWindowFiltersForScope(gitRoot, piSessionId, options),
  };
};

// Example:
// const windows = listBashWindows(context);
// // [
// //   { id: "@2172", index: 3, title: "hello-sleep-done", outputFile: "/tmp/..." },
// // ]
//
// Lists only bash-created windows matching the resolved scope.
export const listBashWindows = (context: TmuxBashContext): TmuxWindow[] =>
  getWindows(context.session, context.filters).filter((window) => window.outputFile);

// Example:
// const count = clearIdleBashWindows(context);
// // 0
// // or 3, after killing 3 finished bash-created windows
// // or "missing", if the tmux session does not exist
//
// “Idle” means:
// - window was created by tmux-bash
// - pane command is a shell: bash/zsh/sh/fish/dash
// - shell has no child process left
export const clearIdleBashWindows = (context: TmuxBashContext): number | "missing" => {
  const idle = getIdleWindows(context);
  if (idle === "missing") return "missing";

  idle.forEach((window) =>
    execSafe(`tmux kill-window -t ${shellQuote(`${context.session}:${window.index}`)}`),
  );
  return idle.length;
};
