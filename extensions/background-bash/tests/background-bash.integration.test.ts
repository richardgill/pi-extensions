import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  initTheme,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { backgroundBash } from "../src/extension";
import { renderCompletionMessage, renderProcessResult, sanitizedResult } from "../src/render";
import type { BackgroundBashDetails } from "../src/process-manager";
import type { BashInput, BashProcessInput } from "../src/tools";

type TestResult = AgentToolResult<BackgroundBashDetails | undefined>;
type TestTool = {
  name: string;
  execute: (
    id: string,
    input: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((result: TestResult) => void) | undefined,
    ctx: ExtensionContext,
  ) => Promise<TestResult>;
  renderCall?: (
    input: BashInput,
    theme: typeof identityTheme,
    context: Record<string, unknown>,
  ) => Component;
  renderResult?: (
    result: TestResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: typeof identityTheme,
    context: Record<string, unknown>,
  ) => Component;
};

type TestMessage = {
  customType: string;
  content: string;
  details?: unknown;
  triggerTurn?: boolean;
  deliverAs?: string;
};

type EventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

type Harness = {
  messages: TestMessage[];
  statuses: Array<string | undefined>;
  runBash: (
    input: BashInput,
    options?: { signal?: AbortSignal; onUpdate?: (result: TestResult) => void },
  ) => Promise<TestResult>;
  runProcess: (input: BashProcessInput) => Promise<TestResult>;
  renderBashCall: (input: BashInput) => string;
  renderBashResult: (result: TestResult) => string;
  shutdown: () => Promise<void>;
};

const tempDirs: string[] = [];
const activeShutdowns: Array<() => Promise<void>> = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

const resultText = (result: TestResult): string => {
  const content = result.content[0];
  return content?.type === "text" ? content.text : "";
};

const pgidFrom = (result: TestResult): number => {
  const match = resultText(result).match(/\bPGID:? (\d+)/);
  if (!match) throw new Error("Result did not contain a PGID");
  return Number(match[1]);
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 3000,
  startedAt = Date.now(),
): Promise<void> => {
  if (predicate()) return;
  if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
  await delay(20);
  await waitFor(predicate, timeoutMs, startedAt);
};

const processGroupExists = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const createHarness = async (
  overrides: { preserveOutputFiles?: boolean; piSettings?: Record<string, unknown> } = {},
): Promise<Harness> => {
  const outputDir = await mkdtemp(join(tmpdir(), "pi-background-bash-test-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-background-bash-agent-"));
  tempDirs.push(outputDir, agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (overrides.piSettings) {
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(overrides.piSettings), "utf8");
  }
  const tools: TestTool[] = [];
  const handlers = new Map<string, EventHandler[]>();
  const messages: TestMessage[] = [];
  const statuses: Array<string | undefined> = [];
  const context = {
    cwd: process.cwd(),
    hasUI: true,
    model: undefined,
    sessionManager: {
      getSessionId: () => "background-bash-test",
      getSessionFile: () => undefined,
    },
    ui: {
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
    },
  } as unknown as ExtensionContext;
  const pi = {
    on: (name: string, handler: EventHandler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: unknown) => tools.push(tool as TestTool),
    registerMessageRenderer: () => undefined,
    sendMessage: (
      message: { customType: string; content: string | unknown[]; details?: unknown },
      options?: { triggerTurn?: boolean; deliverAs?: string },
    ) => {
      messages.push({
        customType: message.customType,
        content: typeof message.content === "string" ? message.content : "",
        details: message.details,
        ...options,
      });
    },
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;

  backgroundBash({
    outputDir,
    preserveOutputFiles: overrides.preserveOutputFiles ?? true,
    defaultTimeoutSeconds: 5,
    maxTimeoutSeconds: 10,
  })(pi);

  const emit = async (name: string): Promise<void> => {
    await Promise.all(
      (handlers.get(name) ?? []).map((handler) => Promise.resolve(handler({}, context))),
    );
  };
  await emit("session_start");

  const tool = (name: string): TestTool => {
    const registered = tools.find((item) => item.name === name);
    if (!registered) throw new Error(`Missing tool: ${name}`);
    return registered;
  };

  const shutdown = () => emit("session_shutdown");
  activeShutdowns.push(shutdown);

  return {
    messages,
    statuses,
    runBash: (input, options = {}) =>
      tool("bash").execute(
        "bash-test",
        input as Record<string, unknown>,
        options.signal,
        options.onUpdate,
        context,
      ),
    runProcess: (input) =>
      tool("bash_process").execute(
        "process-test",
        input as Record<string, unknown>,
        undefined,
        undefined,
        context,
      ),
    renderBashCall: (input) => {
      initTheme("dark", false);
      const renderCall = tool("bash").renderCall;
      if (!renderCall) throw new Error("Bash call renderer was not registered");
      return renderCall(input, identityTheme, {
        state: { startedAt: undefined, endedAt: undefined, interval: undefined },
        lastComponent: undefined,
        executionStarted: true,
      })
        .render(300)
        .join("\n")
        .trimEnd();
    },
    renderBashResult: (result) => {
      initTheme("dark", false);
      const renderResult = tool("bash").renderResult;
      if (!renderResult) throw new Error("Bash result renderer was not registered");
      const renderContext = {
        args: { command: "long output" },
        state: { startedAt: Date.now(), endedAt: Date.now() },
        lastComponent: undefined as Component | undefined,
        executionStarted: true,
        isError: false,
        invalidate: () => undefined,
        showImages: false,
      };
      renderContext.lastComponent = renderResult(
        result,
        { expanded: false, isPartial: false },
        identityTheme,
        renderContext,
      );
      return renderResult(
        result,
        { expanded: false, isPartial: false },
        identityTheme,
        renderContext,
      )
        .render(300)
        .join("\n");
    },
    shutdown,
  };
};

const identityTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

afterEach(async () => {
  if (originalAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(activeShutdowns.splice(0).map((shutdown) => shutdown()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("background bash", () => {
  it("renders a background handoff deadline separately from a killing timeout", async () => {
    const harness = await createHarness();

    expect(
      harness.renderBashCall({
        command: "sleep 30",
        timeout: 1,
        timeoutAction: "background",
      }),
    ).toBe("$ sleep 30 (background after 1s)");
    expect(
      harness.renderBashCall({ command: "sleep 30", timeout: 1, timeoutAction: "kill" }),
    ).toContain("(timeout 1s)");

    await harness.shutdown();
  });

  it("renders completed background processes without expired process identifiers", () => {
    const content = [
      "Background bash finished\nPGID 123\nName: timed-handoff\nCommand: printf done\nElapsed: 3.0s\nStatus: success\nExit code: 0",
      "before\nafter",
      "Full output: /tmp/123.log",
    ].join("\n\n");
    const rendered = renderCompletionMessage(
      content,
      {
        status: "success",
        pgid: 123,
        name: "timed-handoff",
        command: "printf done",
        elapsedMs: 3000,
        exitCode: 0,
        logPath: "/tmp/123.log",
        truncated: false,
      },
      identityTheme,
    )
      .render(300)
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd();

    expect(rendered).toBe("✓ timed-handoff finished in 3.0s\n  $ printf done\n\nbefore\nafter");
    expect(rendered).not.toContain("PGID");
  });

  it("includes the exit code in failed background completion headings", () => {
    const rendered = renderCompletionMessage(
      "Background bash failed\n\nstarted\nfailed\n\nFull output: /tmp/456.log",
      {
        status: "failed",
        pgid: 456,
        name: "failing-background",
        command: "run tests",
        elapsedMs: 2100,
        exitCode: 9,
        logPath: "/tmp/456.log",
        truncated: false,
      },
      identityTheme,
    )
      .render(300)
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd();

    expect(rendered).toBe(
      "✗ failing-background failed in 2.1s (exit 9)\n  $ run tests\n\nstarted\nfailed",
    );
  });

  it("shows one log path and controls while inspecting an active process", () => {
    const logPath = "/tmp/active.log";
    const rendered = renderProcessResult(
      {
        content: [
          {
            type: "text",
            text: `running \u001b[31mred\u001b[0m\u0000\r\n\nFull output: ${logPath}`,
          },
        ],
        details: { pgid: 123, active: true, fullOutputPath: logPath },
      },
      identityTheme,
    )
      .render(300)
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd();

    expect(rendered).toContain("running red");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u0000");
    expect(rendered).toContain(`Log: ${logPath}`);
    expect(rendered.split(logPath).length - 1).toBe(1);
    expect(rendered).toContain("Inspect group: pgrep -a -g 123");
    expect(rendered).toContain("Kill group:    kill -KILL -- -123");
  });

  it("keeps one log path for truncated output from a stopped process", () => {
    const logPath = "/tmp/stopped.log";
    const rendered = renderProcessResult(
      {
        content: [{ type: "text", text: `tail\n\n[Showing 2 of 10]\nFull output: ${logPath}` }],
        details: { pgid: 456, fullOutputPath: logPath },
      },
      identityTheme,
    )
      .render(300)
      .map((line) => line.trimEnd())
      .join("\n")
      .trimEnd();

    expect(rendered).toContain(`Full output: ${logPath}`);
    expect(rendered.split(logPath).length - 1).toBe(1);
    expect(rendered).not.toContain("Inspect group:");
    expect(rendered).not.toContain("Kill group:");
  });

  it("honors Pi's configured shell path and command prefix", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pi-background-bash-shell-"));
    const shellPath = join(folder, "custom-shell");
    tempDirs.push(folder);
    await writeFile(
      shellPath,
      "#!/bin/sh\nprintf 'custom-shell\\n'\nexec /bin/sh \"$@\"\n",
      "utf8",
    );
    await chmod(shellPath, 0o700);
    const harness = await createHarness({
      piSettings: {
        shellPath,
        shellCommandPrefix: "printf 'configured-prefix\\n'",
      },
    });

    const result = await harness.runBash({
      command: "printf body",
      timeout: 3,
      timeoutAction: "kill",
    });

    expect(resultText(result)).toContain("custom-shell\nconfigured-prefix\nbody");
    await harness.shutdown();
  });

  it("returns foreground output with a stable private log hidden by short-output rendering", async () => {
    const harness = await createHarness();
    const result = await harness.runBash({
      command: "printf short-output",
      timeout: 3,
      timeoutAction: "kill",
    });
    const logPath = result.details?.fullOutputPath;

    expect(resultText(result)).toContain("short-output");
    expect(resultText(result)).toContain(`Full output: ${logPath}`);
    expect(sanitizedResult(result).result.content[0]).toEqual({
      type: "text",
      text: "short-output",
    });
    expect(await readFile(logPath!, "utf8")).toBe("short-output");
    expect((await stat(logPath!)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(logPath!))).mode & 0o777).toBe(0o700);

    await harness.shutdown();
  });

  it("reports one natural explicit-background completion and removes the process", async () => {
    const harness = await createHarness();
    const startedAt = Date.now();
    const result = await harness.runBash({
      command: "printf started; sleep 0.3; printf completed",
      name: "integration",
      background: true,
    });
    const pgid = pgidFrom(result);
    const rendered = harness.renderBashResult(result);

    expect(rendered).toContain(`Log: ${result.details?.fullOutputPath}`);
    expect(rendered.split(result.details!.fullOutputPath!).length - 1).toBe(1);
    expect(resultText(result)).toContain(
      `Started background process: integration · PGID ${pgid}\nResult will be reported automatically when it finishes.`,
    );
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(harness.statuses.at(-1)).toBe("1 background proc");
    expect(resultText(await harness.runProcess({ action: "list" }))).toContain(String(pgid));
    await waitFor(() => harness.messages.length === 1);

    expect(harness.messages[0]?.triggerTurn).toBe(true);
    expect(harness.messages[0]?.deliverAs).toBe("followUp");
    expect(harness.messages[0]?.content).toContain("startedcompleted");
    expect(harness.messages[0]?.content).toContain(`PGID ${pgid}`);
    expect(harness.statuses.at(-1)).toBeUndefined();
    expect(resultText(await harness.runProcess({ action: "list" }))).toBe(
      "No active background processes.",
    );

    await harness.shutdown();
  });

  it("reports natural background failures", async () => {
    const harness = await createHarness();
    const result = await harness.runBash({ command: "printf failed; exit 7", background: true });
    const pgid = pgidFrom(result);
    await waitFor(() => harness.messages.length === 1);

    expect(harness.messages[0]?.content).toContain("Background bash failed");
    expect(harness.messages[0]?.content).toContain("Exit code: 7");
    expect(harness.messages[0]?.content).toContain("failed");
    expect(harness.messages[0]?.content).toContain(`PGID ${pgid}`);

    await harness.shutdown();
  });

  it("hands the original foreground process off and detaches the turn abort signal", async () => {
    const harness = await createHarness();
    const controller = new AbortController();
    const result = await harness.runBash(
      {
        command: "printf 'shell=%s before\\n' $$; sleep 1.3; printf after",
        timeout: 1,
        timeoutAction: "background",
      },
      { signal: controller.signal },
    );
    const pgid = pgidFrom(result);
    expect(result.details?.active).toBe(true);
    controller.abort();
    await waitFor(() => harness.messages.length === 1, 3000);

    expect(resultText(result)).toContain(`shell=${pgid} before`);
    expect(harness.messages[0]?.content).toContain("after");
    expect(harness.messages).toHaveLength(1);

    await harness.shutdown();
  });

  it("kills a whole process group intentionally without a completion message", async () => {
    const harness = await createHarness();
    const result = await harness.runBash({
      command: "sleep 30 & child=$!; echo child=$child; wait",
      background: true,
    });
    const pgid = pgidFrom(result);
    await delay(100);
    const peeked = await harness.runProcess({ action: "peek", pgid });
    const killed = await harness.runProcess({ action: "kill", pgid });

    expect(resultText(peeked)).toContain("child=");
    expect(resultText(killed)).toContain("Killed background process");
    expect(resultText(killed)).toContain("child=");
    expect(processGroupExists(pgid)).toBe(false);
    await delay(100);
    expect(harness.messages).toHaveLength(0);
    expect(resultText(await harness.runProcess({ action: "list" }))).toBe(
      "No active background processes.",
    );

    await harness.shutdown();
  });

  it("does not spawn a command when its signal is already aborted", async () => {
    const harness = await createHarness();
    const folder = await mkdtemp(join(tmpdir(), "pi-background-bash-abort-"));
    const marker = join(folder, "spawned");
    const controller = new AbortController();
    tempDirs.push(folder);
    controller.abort();

    await expect(
      harness.runBash(
        { command: `touch '${marker}'`, timeout: 3, timeoutAction: "kill" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("aborted");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    await harness.shutdown();
  });

  it("kills on timeout and leaves no active process or completion", async () => {
    const harness = await createHarness();
    let error: Error | undefined;

    try {
      await harness.runBash({
        command: "printf before; sleep 30",
        timeout: 1,
        timeoutAction: "kill",
      });
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).toContain("Command timed out after 1 seconds");
    expect(error?.message).toContain("Full output:");
    expect(resultText(await harness.runProcess({ action: "list" }))).toBe(
      "No active background processes.",
    );
    expect(harness.messages).toHaveLength(0);

    await harness.shutdown();
  });

  it("explains commands that require a terminal", async () => {
    const harness = await createHarness();
    let error: Error | undefined;

    try {
      await harness.runBash({
        command: "printf 'Error: stdout is not a terminal\\n' >&2; exit 1",
        timeout: 5,
        timeoutAction: "kill",
      });
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).toContain("Command requires a terminal (PTY unsupported)");
    expect(error?.message).not.toContain("stdout is not a terminal");

    await harness.shutdown();
  });

  it("kills active process groups silently on session shutdown", async () => {
    const harness = await createHarness({ preserveOutputFiles: false });
    const result = await harness.runBash({ command: "sleep 30", background: true });
    const pgid = pgidFrom(result);

    await harness.shutdown();

    expect(processGroupExists(pgid)).toBe(false);
    expect(harness.messages).toHaveLength(0);
    await expect(stat(result.details!.fullOutputPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps completed long output bounded without stale process hints", async () => {
    const harness = await createHarness();
    const result = await harness.runBash({
      command: "for i in $(seq 1 2105); do echo line-$i; done",
      timeout: 5,
      timeoutAction: "kill",
    });
    const logPath = result.details?.fullOutputPath;
    const rendered = harness.renderBashResult(result);
    const fullLog = await readFile(logPath!, "utf8");

    expect(result.details?.truncation?.truncated).toBe(true);
    expect(Buffer.byteLength(resultText(result))).toBeLessThan(60 * 1024);
    expect(fullLog).toContain("line-1\n");
    expect(fullLog).toContain("line-2105\n");
    expect(rendered.split("\n").length).toBeLessThan(30);
    expect(rendered).toContain("to expand");
    expect(rendered).toContain(`Full output: ${logPath}`);
    expect(rendered.split(logPath!).length - 1).toBe(1);
    expect(rendered).not.toContain("Follow output:");
    expect(rendered).not.toContain("Inspect group:");
    expect(rendered).not.toContain("Kill group:");

    await harness.shutdown();
  });
});
