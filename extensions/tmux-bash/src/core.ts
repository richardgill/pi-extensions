import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  calcTmuxSessionName,
  getGitRoot,
  getWindows,
  tmuxWindowFiltersForScope,
  type TmuxWindow,
  type TmuxWindowFilters,
} from "./tmux-utils";
import type { ResolvedOptions } from "./config";

export { loadTmuxBashConfig, TmuxBashConfigSchema } from "./config";
export {
  DEFAULT_OPTIONS,
  resolveOptions,
  TmuxBashOptionsSchema,
  type ResolvedOptions,
  type TmuxBashOptions,
} from "./config";
export type { TmuxWindow, TmuxWindowFilters } from "./tmux-utils";

export type TmuxBashContext = {
  gitRoot: string;
  session: string;
  filters: TmuxWindowFilters;
  tmuxBinary: string;
};

// Example:
// const options = loadTmuxBashConfig();
// const context = resolveTmuxBashContext(ctx, options);
// if (!context) ctx.ui.notify("Not in a git repository.", "error");
//
// Resolves:
// - current git root
// - tmux session name from config
// - window filters from config
export const resolveTmuxBashContext = (
  ctx: ExtensionContext,
  options: ResolvedOptions,
): TmuxBashContext | null => {
  const gitRoot = getGitRoot(ctx.cwd);
  if (!gitRoot) return null;

  return {
    gitRoot,
    session: calcTmuxSessionName(gitRoot, options),
    filters: tmuxWindowFiltersForScope(gitRoot, ctx.sessionManager.getSessionId(), options),
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
