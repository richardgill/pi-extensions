import {
  backgroundSessionName,
  getGitRoot,
  getWindows,
  type TmuxWindow,
  type TmuxWindowFilters,
} from "./tmux-utils.js";
import type { ResolvedOptions } from "./extension.js";

export type { TmuxWindow, TmuxWindowFilters } from "./tmux-utils.js";

export type TmuxBashContext = {
  gitRoot: string;
  session: string;
  filters: TmuxWindowFilters;
  tmuxBinary: string;
};

type ResolveTmuxBashContextInput = {
  cwd: string;
  piSessionId: string;
  options: ResolvedOptions;
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
    tmuxBinary: options.tmuxBinary,
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
  getWindows(context.session, context.filters, context.tmuxBinary).filter(
    (window) => window.outputFile,
  );
