import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_BASH_STATUS_KEY, resolveOptions, type TmuxBashOptions } from "./config";
import { cleanupState, createState, resetRunDir, updateBackgroundProcessStatus } from "./runtime";
import { registerMessageRenderers } from "./renderers/messages";
import { registerBashTool } from "./tools/bash-tool";
import { registerTmuxTool } from "./tools/tmux-tool";

export { DEFAULT_OPTIONS, TmuxBashOptionsSchema, type TmuxBashOptions } from "./config";

export const tmuxBash = (input: TmuxBashOptions = {}) => {
  const options = resolveOptions(input);

  return (pi: ExtensionAPI): void => {
    const state = createState();

    pi.on("session_start", async (_event, ctx) => {
      resetRunDir(state, options, ctx.sessionManager.getSessionId());
      state.statusContext = ctx;
      updateBackgroundProcessStatus(ctx, options);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.setStatus(BACKGROUND_BASH_STATUS_KEY, undefined);
      cleanupState(state, options);
    });

    registerBashTool(pi, state, options);
    if (options.tmuxEnabledActions.length > 0) registerTmuxTool(pi, state, options);
    registerMessageRenderers(pi, options);
  };
};
