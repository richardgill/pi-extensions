import { stripVTControlCharacters } from "node:util";
import {
  DynamicBorder,
  getSelectListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  SelectList,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { resultText, stripModelOnlyLogLine } from "./render";
import type { ManagedProcess, ProcessManager } from "./process-manager";

type ProcAction =
  | { type: "view"; process: ManagedProcess }
  | { type: "kill"; process: ManagedProcess };

const MAX_VISIBLE_LOG_LINES = 20;

const processLabel = (process: ManagedProcess): string => {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - process.startedAt) / 1000));
  const command = process.command.replace(/\s+/g, " ").trim();
  const name = process.name ? `${process.name}: ` : "";
  return `${name}${command} · PGID ${process.pgid} · ${elapsedSeconds}s`;
};

const sanitizeLog = (text: string): string =>
  Array.from(stripVTControlCharacters(text))
    .filter((character) => {
      const code = character.codePointAt(0);
      return (
        code === 0x09 || code === 0x0a || (code !== undefined && code >= 0x20 && code !== 0x7f)
      );
    })
    .join("");

const latestLog = (process: ManagedProcess): string => {
  const output = stripModelOnlyLogLine(resultText(process.latest), process.logPath);
  return sanitizeLog(output) || "(no output yet)";
};

const processItems = (processes: ManagedProcess[]) =>
  processes.map((process) => ({
    value: String(process.pgid),
    label: processLabel(process),
  }));

const showProcessPicker = async (
  ctx: ExtensionCommandContext,
  processes: ManagedProcess[],
): Promise<ProcAction | undefined> => {
  if (processes.length === 0) {
    ctx.ui.notify("No active background processes.", "info");
    return undefined;
  }

  const choices = new Map(processes.map((process) => [String(process.pgid), process]));
  return ctx.ui.custom<ProcAction | undefined>((tui, theme, _keybindings, done) => {
    const list = new SelectList(
      processItems(processes),
      Math.min(processes.length, 10),
      getSelectListTheme(),
      { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 },
    );
    list.onSelect = (item) => {
      const process = choices.get(item.value);
      if (process) done({ type: "view", process });
    };
    list.onCancel = () => done(undefined);

    const borderColor = (text: string) => theme.fg("border", text);
    const container = new Container();
    container.addChild(new DynamicBorder(borderColor));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", theme.bold("Background processes")), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        theme.fg(
          "dim",
          "  Enter to view logs · Ctrl+C to terminate selected process · Esc to exit",
        ),
        0,
        0,
      ),
    );
    container.addChild(new Spacer(1));
    container.addChild(new DynamicBorder(borderColor));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (matchesKey(data, Key.ctrl("c"))) {
          const selected = list.getSelectedItem();
          const process = selected ? choices.get(selected.value) : undefined;
          if (process) done({ type: "kill", process });
          return;
        }
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
};

const showProcessLog = async (
  ctx: ExtensionCommandContext,
  process: ManagedProcess,
): Promise<ProcAction | undefined> =>
  ctx.ui.custom<ProcAction | undefined>((tui, theme, _keybindings, done) => {
    let closed = false;
    const refreshTimer = setInterval(() => {
      if (!closed) tui.requestRender();
    }, 250);

    const logText = new Text("", 0, 0);
    const borderColor = (text: string) => theme.fg("border", text);
    const container = new Container();
    container.addChild(new DynamicBorder(borderColor));
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", theme.bold("Background process log")), 0, 0));
    container.addChild(
      new Text(theme.fg("dim", `PGID ${process.pgid} · ${process.name ?? process.command}`), 0, 0),
    );
    container.addChild(new Spacer(1));
    container.addChild(logText);
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        theme.fg("dim", "  Esc to return to process list · Ctrl+C to terminate this process"),
        0,
        0,
      ),
    );
    container.addChild(new DynamicBorder(borderColor));

    const renderLog = (width: number): string[] => {
      const visible = latestLog(process)
        .split("\n")
        .slice(-MAX_VISIBLE_LOG_LINES)
        .map((line) => theme.fg("toolOutput", truncateToWidth(line, width, "")))
        .join("\n");
      logText.setText(visible);
      return container.render(width);
    };

    const component: Component & { dispose(): void } = {
      render: renderLog,
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        if (matchesKey(data, Key.escape)) {
          done(undefined);
        } else if (matchesKey(data, Key.ctrl("c"))) {
          done({ type: "kill", process });
        }
      },
      dispose: () => {
        closed = true;
        clearInterval(refreshTimer);
      },
    };
    return component;
  });

const killProcess = async (
  ctx: ExtensionCommandContext,
  manager: ProcessManager,
  process: ManagedProcess,
): Promise<boolean> => {
  const confirmed = await ctx.ui.confirm(
    `Kill ${process.name ?? `PGID ${process.pgid}`}?`,
    process.command,
  );
  if (!confirmed) return false;

  try {
    await manager.kill(process.pgid);
    ctx.ui.notify(`Killed ${process.name ?? `PGID ${process.pgid}`}.`, "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
  }
  return true;
};

const runInteractiveProc = async (
  ctx: ExtensionCommandContext,
  manager: ProcessManager,
  processes: ManagedProcess[],
): Promise<void> => {
  let action = await showProcessPicker(ctx, processes);
  while (action) {
    if (action.type === "view") {
      const logAction = await showProcessLog(ctx, action.process);
      if (logAction?.type === "kill") {
        action = logAction;
      } else {
        action = await showProcessPicker(
          ctx,
          [...manager.processes.values()].filter((process) => process.notifyOnExit),
        );
      }
      continue;
    }

    if (await killProcess(ctx, manager, action.process)) return;
    action = await showProcessPicker(
      ctx,
      [...manager.processes.values()].filter((process) => process.notifyOnExit),
    );
  }
};

const runFallbackProc = async (
  ctx: ExtensionCommandContext,
  manager: ProcessManager,
  processes: ManagedProcess[],
): Promise<void> => {
  const choices = new Map(processes.map((process) => [processLabel(process), process]));
  const selected = await ctx.ui.select("Select a process to kill", [...choices.keys()]);
  const process = selected ? choices.get(selected) : undefined;
  if (process) await killProcess(ctx, manager, process);
};

export const registerProcCommand = (pi: ExtensionAPI, manager: ProcessManager): void => {
  pi.registerCommand("proc", {
    description: "View logs and terminate active background processes",
    handler: async (_args, ctx) => {
      const processes = [...manager.processes.values()].filter((process) => process.notifyOnExit);
      if (processes.length === 0) {
        ctx.ui.notify("No active background processes.", "info");
        return;
      }

      if (ctx.mode === "tui") {
        await runInteractiveProc(ctx, manager, processes);
      } else {
        await runFallbackProc(ctx, manager, processes);
      }
    },
  });
};
