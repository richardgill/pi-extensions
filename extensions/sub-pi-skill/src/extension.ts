import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type SubPiSkillOptions = {
  commandName?: string;
};

export const extension = (options: SubPiSkillOptions = {}) => {
  const commandName = options.commandName ?? "sub-pi-skill";

  return (pi: ExtensionAPI): void => {
    pi.registerCommand(commandName, {
      description: "Run the sub-pi-skill extension",
      handler: async (_args, ctx) => {
        ctx.ui.notify("sub-pi-skill ran", "info");
      },
    });
  };
};
