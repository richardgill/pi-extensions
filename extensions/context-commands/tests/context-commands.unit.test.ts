import type {
  ExecResult,
  ExtensionAPI,
  ExtensionCommandContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { contextCommands } from "../src/extension";

type Notification = { message: string; level: string };

const createHarness = (
  result: ExecResult = { stdout: "diff output", stderr: "", code: 0, killed: false },
) => {
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const events: string[] = [];
  const notifications: Notification[] = [];
  const exec = vi.fn(async () => result);
  const registerMessageRenderer = vi.fn();
  const sendMessage = vi.fn(() => events.push("context"));
  const sendUserMessage = vi.fn(() => events.push("user"));
  const pi = {
    exec,
    registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) =>
      commands.set(name, options),
    registerMessageRenderer,
    sendMessage,
    sendUserMessage,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/repo",
    isIdle: () => true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  } as unknown as ExtensionCommandContext;

  return {
    commands,
    ctx,
    events,
    exec,
    notifications,
    pi,
    registerMessageRenderer,
    sendMessage,
    sendUserMessage,
  };
};

const getHandler = (
  commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>,
  name: string,
) => {
  const handler = commands.get(name)?.handler;
  if (!handler) throw new Error(`Command not registered: ${name}`);
  return handler;
};

describe("contextCommands", () => {
  it("registers configured slash commands", () => {
    const harness = createHarness();

    contextCommands({
      commands: [
        { name: "diff", description: "Load diff", command: "/bin/diff" },
        { name: "pr-diff", description: "Load PR diff", command: "/bin/pr-diff" },
      ],
    })(harness.pi);

    expect(
      [...harness.commands.entries()].map(([name, command]) => [name, command.description]),
    ).toEqual([
      ["diff", "Load diff"],
      ["pr-diff", "Load PR diff"],
    ]);
  });

  it("renders loaded context with Pi's configured output padding", () => {
    const harness = createHarness();
    contextCommands()(harness.pi);

    const renderer = harness.registerMessageRenderer.mock.calls[0]?.[1];
    if (typeof renderer !== "function") throw new Error("Context renderer not registered");

    const message = {
      role: "custom",
      customType: "context-command",
      content: "",
      display: true,
      details: { summary: "Context loaded" },
      timestamp: 0,
    };
    const theme = { fg: (_color: string, text: string) => text };

    expect(renderer(message, { expanded: false, outputPad: 0 }, theme).render(20)[0]).toBe(
      "Context loaded      ",
    );
    expect(renderer(message, { expanded: false, outputPad: 1 }, theme).render(20)[0]).toBe(
      " Context loaded     ",
    );
  });

  it("loads context without sending a user message when invoked without args", async () => {
    const harness = createHarness({
      stdout: "local changes",
      stderr: "diagnostic",
      code: 0,
      killed: false,
    });
    contextCommands({
      commands: [
        {
          name: "diff",
          description: "Load diff",
          command: "/bin/git-local-diff",
          commandArgs: ["--stat"],
          timeoutMs: 5_000,
        },
      ],
    })(harness.pi);

    await getHandler(harness.commands, "diff")("", harness.ctx);

    expect(harness.exec).toHaveBeenCalledWith("/bin/git-local-diff", ["--stat"], {
      cwd: "/repo",
      timeout: 5_000,
    });
    expect(harness.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "context-command",
        content: expect.stringContaining("## stdout\n\nlocal changes\n\n## stderr\n\ndiagnostic"),
        display: true,
      }),
    );
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  it("appends context before sending raw args without passing them to exec", async () => {
    const harness = createHarness();
    contextCommands({
      commands: [
        {
          name: "diff",
          description: "Load diff",
          command: "/bin/git-local-diff",
          commandArgs: ["--fixed"],
        },
      ],
    })(harness.pi);

    await getHandler(harness.commands, "diff")("  review this carefully  ", harness.ctx);

    expect(harness.exec).toHaveBeenCalledWith("/bin/git-local-diff", ["--fixed"], {
      cwd: "/repo",
      timeout: undefined,
    });
    expect(harness.events).toEqual(["context", "user"]);
    expect(harness.sendUserMessage).toHaveBeenCalledWith("  review this carefully  ");
  });

  it("reports non-zero exits without appending context", async () => {
    const harness = createHarness({
      stdout: "",
      stderr: "not a git repository",
      code: 128,
      killed: false,
    });
    contextCommands({
      commands: [{ name: "diff", description: "Load diff", command: "/bin/diff" }],
    })(harness.pi);

    await getHandler(harness.commands, "diff")("fix it", harness.ctx);

    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
    expect(harness.notifications).toEqual([
      {
        message: "/diff failed: exited with code 128: not a git repository",
        level: "error",
      },
    ]);
  });
});
