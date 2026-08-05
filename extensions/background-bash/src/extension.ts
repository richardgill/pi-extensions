import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_BASH_STATUS_KEY, resolveOptions, type BackgroundBashOptions } from "./config";
import { resolvePiBashSettings } from "./pi-settings";
import { registerProcCommand } from "./proc-command";
import { ProcessManager } from "./process-manager";
import { registerCompletionRenderer, registerTools } from "./tools";

export {
  BackgroundBashConfigSchema,
  BackgroundBashOptionsSchema,
  DEFAULT_OPTIONS,
  loadBackgroundBashConfig,
  resolveOptions,
  type BackgroundBashOptions,
} from "./config";

const formatBackgroundProcessStatus = (count: number): string | undefined =>
  count > 0 ? `${count} background proc${count === 1 ? "" : "s"}` : undefined;

export const backgroundBash = (input: BackgroundBashOptions = {}) => {
  const options = resolveOptions(input);

  return (pi: ExtensionAPI): void => {
    let statusContext: ExtensionContext | undefined;
    const manager = new ProcessManager(options, (count) => {
      if (!statusContext?.hasUI) return;
      statusContext.ui.setStatus(BACKGROUND_BASH_STATUS_KEY, formatBackgroundProcessStatus(count));
    });

    pi.on("session_start", async (_event, ctx) => {
      statusContext = ctx;
      await manager.initialize(
        ctx.sessionManager.getSessionId(),
        ctx.cwd,
        resolvePiBashSettings(ctx),
      );
      if (ctx.hasUI) ctx.ui.setStatus(BACKGROUND_BASH_STATUS_KEY, undefined);
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      await manager.shutdown();
      if (ctx.hasUI) ctx.ui.setStatus(BACKGROUND_BASH_STATUS_KEY, undefined);
      statusContext = undefined;
    });

    registerTools(pi, manager, options);
    registerProcCommand(pi, manager);
    registerCompletionRenderer(pi);
  };
};
