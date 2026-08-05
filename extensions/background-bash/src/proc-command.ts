import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ManagedProcess, ProcessManager } from "./process-manager";

const processLabel = (process: ManagedProcess): string => {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - process.startedAt) / 1000));
  const command = process.command.replace(/\s+/g, " ").trim();
  const name = process.name ? `${process.name}: ` : "";
  return `${name}${command} · PGID ${process.pgid} · ${elapsedSeconds}s`;
};

export const registerProcCommand = (pi: ExtensionAPI, manager: ProcessManager): void => {
  pi.registerCommand("proc", {
    description: "List and kill active background processes",
    handler: async (_args, ctx) => {
      const processes = [...manager.processes.values()].filter((process) => process.notifyOnExit);
      if (processes.length === 0) {
        ctx.ui.notify("No active background processes.", "info");
        return;
      }

      const choices = new Map(processes.map((process) => [processLabel(process), process]));
      const selected = await ctx.ui.select("Select a process to kill", [...choices.keys()]);
      const process = selected ? choices.get(selected) : undefined;
      if (!process) return;

      const confirmed = await ctx.ui.confirm(
        `Kill ${process.name ?? `PGID ${process.pgid}`}?`,
        process.command,
      );
      if (!confirmed) return;

      try {
        await manager.kill(process.pgid);
        ctx.ui.notify(`Killed ${process.name ?? `PGID ${process.pgid}`}.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });
};
