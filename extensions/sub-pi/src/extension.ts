import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type SubPiOptions = {
  commandName?: string;
};

export const extension = (options: SubPiOptions = {}) => {
  const commandName = options.commandName ?? "sub-pi";

  return (pi: ExtensionAPI): void => {
    pi.registerCommand(commandName, {
      description: "Run the sub-pi extension",
      handler: async (_args, ctx) => {
        ctx.ui.notify("sub-pi ran", "info");
      },
    });
  };
};
