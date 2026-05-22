import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BACKGROUND_BASH_STATUS_KEY, resolveOptions, type TmuxBashOptions } from "./options.js";
import {
  cleanupState,
  createState,
  resetRunDir,
  updateBackgroundProcessStatus,
} from "./runtime.js";
import { registerMessageRenderers } from "./renderers/messages.js";
import { registerBashTool } from "./tools/bash-tool.js";
import { registerTmuxTool } from "./tools/tmux-tool.js";

export { DEFAULT_OPTIONS, type TmuxBashOptions } from "./options.js";

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
    registerTmuxTool(pi, state, options);
    registerMessageRenderers(pi, options);
  };
};
