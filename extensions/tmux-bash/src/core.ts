import {
  calcTmuxSessionName,
  getGitRoot,
  getWindows,
  tmuxWindowFiltersForScope,
  type TmuxWindow,
  type TmuxWindowFilters,
} from "./tmux-utils.js";
import type { ResolvedOptions } from "./options.js";

export { loadTmuxBashConfig, TmuxBashConfigSchema } from "./config.js";
export {
  DEFAULT_OPTIONS,
  resolveOptions,
  type ResolvedOptions,
  type TmuxBashOptions,
} from "./options.js";
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
    session: calcTmuxSessionName(gitRoot, options),
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
