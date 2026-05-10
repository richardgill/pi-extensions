import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@mariozechner/pi-coding-agent";
import { createSessionSidecarPath } from "@richardgill/pi-file-collector";
import { describe, expect, it, vi } from "vitest";

const completeSimpleMock = vi.hoisted(() => vi.fn());

vi.mock("@mariozechner/pi-ai", () => ({ completeSimple: completeSimpleMock }));
import {
  buildEvidencePacket,
  buildUpdaterSystemPrompt,
  prependSnapshot,
  readLatestSnapshot,
  resolveCurrentOutputPath,
  resolveOptions,
  resolveOutputPath,
  taskContext,
  updateTaskContextJsonl,
  validateModelSnapshot,
  writeCurrentSnapshot,
  type TaskContextSnapshot,
} from "../src/extension.js";

const snapshot = (title: string): TaskContextSnapshot => ({
  title,
  autoUpdatedAt: "2026-05-09T00:00:00.000Z",
  novelUserContext: [],
  novelCommands: [],
  relevantFiles: [],
});

const turnEvent = (): TurnEndEvent =>
  ({
    type: "turn_end",
    turnIndex: 7,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "assistant text" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.2",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    },
    toolResults: [
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "tool content" }],
        isError: false,
        timestamp: 0,
      },
    ],
  }) as TurnEndEvent;

type RegisteredHandlers = {
  turn_start?: (event: { turnIndex: number }, ctx: ExtensionContext) => Promise<void> | void;
  turn_end?: (event: TurnEndEvent, ctx: ExtensionContext) => Promise<void> | void;
};

const createPi = () => {
  const handlers: RegisteredHandlers = {};
  const pi = {
    on: vi.fn((event: string, handler: unknown) => {
      if (event === "turn_start") {
        handlers.turn_start = handler as RegisteredHandlers["turn_start"];
      }
      if (event === "turn_end") {
        handlers.turn_end = handler as RegisteredHandlers["turn_end"];
      }
    }),
  } as unknown as ExtensionAPI;
  return { pi, handlers };
};

const createContext = (cwd: string, sessionFile: string): ExtensionContext =>
  ({
    cwd,
    hasUI: true,
    ui: { notify: vi.fn() },
    sessionManager: { getSessionFile: () => sessionFile },
    modelRegistry: {
      find: vi.fn(() => ({ provider: "openai", id: "gpt-5.2" })),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "api-key", headers: {} })),
    },
  }) as unknown as ExtensionContext;

const modelResponse = (value: unknown) => ({
  stopReason: "stop",
  content: [{ type: "text", text: JSON.stringify(value) }],
});

describe("resolveOptions", () => {
  it("uses defaults and allows model configuration overrides", () => {
    expect(
      resolveOptions({
        model: { provider: "anthropic", id: "claude-test", thinkingLevel: "low" },
      }),
    ).toMatchObject({
      outputPath: "./overlay/task-context.jsonl",
      model: {
        provider: "anthropic",
        id: "claude-test",
        thinkingLevel: "low",
      },
    });
  });
});

describe("validateModelSnapshot", () => {
  it("adds autoUpdatedAt and validates shape", () => {
    const now = new Date("2026-05-09T12:00:00.000Z");

    expect(validateModelSnapshot({ ...snapshot("Next"), autoUpdatedAt: undefined }, now)).toEqual({
      ...snapshot("Next"),
      autoUpdatedAt: "2026-05-09T12:00:00.000Z",
    });
  });

  it("overwrites model-provided timestamps", () => {
    const now = new Date("2026-05-09T12:00:00.000Z");

    expect(
      validateModelSnapshot(
        { ...snapshot("Next"), autoUpdatedAt: "1999-01-01T00:00:00.000Z" },
        now,
      ),
    ).toMatchObject({ autoUpdatedAt: "2026-05-09T12:00:00.000Z" });
  });

  it("accepts whole-file and range relevant file entries", () => {
    const now = new Date("2026-05-09T12:00:00.000Z");
    const modelOutput = {
      ...snapshot("Next"),
      novelCommands: [{ command: "pnpm test", notes: "Run unit tests" }],
      relevantFiles: [
        {
          path: "./src/extension.ts",
          role: "implementation",
          whyImportant: "Core updater",
          type: "whole_file",
        },
        {
          path: "./tests/task-context.unit.test.ts",
          role: "tests",
          whyImportant: "Updater coverage",
          type: "range",
          ranges: [{ start: 10, end: 20 }],
        },
      ],
    };

    expect(validateModelSnapshot(modelOutput, now)).toMatchObject({
      novelCommands: [{ command: "pnpm test", notes: "Run unit tests" }],
      relevantFiles: modelOutput.relevantFiles,
    });
  });

  it("rejects unknown keys and invalid file ranges", () => {
    const now = new Date("2026-05-09T12:00:00.000Z");

    expect(() => validateModelSnapshot({ ...snapshot("Invalid"), extra: true }, now)).toThrow();
    expect(() =>
      validateModelSnapshot(
        {
          ...snapshot("Invalid"),
          relevantFiles: [
            {
              path: "./a.ts",
              role: "implementation",
              whyImportant: "Invalid range",
              type: "range",
              ranges: [{ start: 5, end: 4 }],
            },
          ],
        },
        now,
      ),
    ).toThrow();
  });

  it("rejects malformed commands and discriminated relevant file shapes", () => {
    const now = new Date("2026-05-09T12:00:00.000Z");

    expect(() =>
      validateModelSnapshot({ ...snapshot("Invalid"), novelCommands: ["pnpm test"] }, now),
    ).toThrow();
    expect(() =>
      validateModelSnapshot(
        {
          ...snapshot("Invalid"),
          relevantFiles: [
            {
              path: "./a.ts",
              role: "implementation",
              whyImportant: "Missing ranges",
              type: "range",
            },
          ],
        },
        now,
      ),
    ).toThrow();
    expect(() =>
      validateModelSnapshot(
        {
          ...snapshot("Invalid"),
          relevantFiles: [
            {
              path: "./a.ts",
              role: "implementation",
              whyImportant: "Extra key",
              type: "whole_file",
              ranges: [{ start: 1, end: 1 }],
            },
          ],
        },
        now,
      ),
    ).toThrow();
  });
});

describe("readLatestSnapshot", () => {
  it("returns the empty snapshot when history does not exist", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));

    await expect(readLatestSnapshot(path.join(dir, "missing.jsonl"))).resolves.toEqual({
      title: "",
      autoUpdatedAt: "",
      novelUserContext: [],
      novelCommands: [],
      relevantFiles: [],
    });
  });

  it("reads the first JSONL line as the latest snapshot", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));
    const outputPath = path.join(dir, "task-context.jsonl");
    await writeFile(
      outputPath,
      `${JSON.stringify(snapshot("Latest"))}\n${JSON.stringify(snapshot("Older"))}\n`,
    );

    await expect(readLatestSnapshot(outputPath)).resolves.toMatchObject({ title: "Latest" });
  });

  it("migrates old snapshots", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));
    const outputPath = path.join(dir, "task-context.jsonl");
    const oldSnapshot = {
      ...snapshot("Latest"),
      goal: "Old goal",
      verification: "Old verification",
      outstanding: ["Old outstanding"],
      openQuestions: ["Old question"],
      decisions: ["Old decision"],
      learned: ["Old learned"],
      constraints: ["Old constraint"],
      assumptions: ["Old assumption"],
      contextCommands: [{ command: "git status", notes: "Old generic command" }],
    } as Partial<TaskContextSnapshot> & Record<string, unknown>;
    delete oldSnapshot.novelUserContext;
    await writeFile(outputPath, `${JSON.stringify(oldSnapshot)}\n`);

    await expect(readLatestSnapshot(outputPath)).resolves.toEqual({
      title: "Latest",
      autoUpdatedAt: "2026-05-09T00:00:00.000Z",
      novelUserContext: [],
      novelCommands: [],
      relevantFiles: [],
    });
  });
});

describe("prependSnapshot", () => {
  it("prepends compact snapshots and trims history", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));
    const outputPath = path.join(dir, "task-context.jsonl");
    await writeFile(
      outputPath,
      `${JSON.stringify(snapshot("Old 1"))}\n${JSON.stringify(snapshot("Old 2"))}\n`,
    );

    await prependSnapshot(outputPath, snapshot("New"), 2);

    await expect(readFile(outputPath, "utf8")).resolves.toBe(
      `${JSON.stringify(snapshot("New"))}\n${JSON.stringify(snapshot("Old 1"))}\n`,
    );
  });

  it("creates missing parent directories", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));
    const outputPath = path.join(dir, "nested", "task-context.jsonl");

    await prependSnapshot(outputPath, snapshot("Created"), 10);

    await expect(readFile(outputPath, "utf8")).resolves.toBe(
      `${JSON.stringify(snapshot("Created"))}\n`,
    );
  });
});

describe("writeCurrentSnapshot", () => {
  it("writes pretty JSON and creates missing parent directories", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));
    const outputPath = path.join(dir, "current", "task-context.json");

    await writeCurrentSnapshot(outputPath, snapshot("Current"));

    await expect(readFile(outputPath, "utf8")).resolves.toBe(
      `${JSON.stringify(snapshot("Current"), null, 2)}\n`,
    );
  });

  it("does nothing when no current output path is configured", async () => {
    await expect(writeCurrentSnapshot(undefined, snapshot("Skipped"))).resolves.toBeUndefined();
  });
});

describe("buildUpdaterSystemPrompt", () => {
  it("renders json shape and update instructions variables", () => {
    expect(
      buildUpdaterSystemPrompt(
        resolveOptions({
          jsonShape: '{"title":""}',
          updaterPrompt: "Shape:\n{{jsonShape}}\nInstructions:\n{{ updateInstructions }}",
          updateInstructions: "Keep it short.",
        }),
      ),
    ).toBe('Shape:\n{"title":""}\nInstructions:\nKeep it short.');
  });

  it("includes novelUserContext in the default JSON shape", () => {
    expect(buildUpdaterSystemPrompt(resolveOptions())).toContain("novelUserContext");
  });
});

describe("buildEvidencePacket", () => {
  it("bounds assistant text, tool results, and file events", () => {
    const options = resolveOptions({
      assistantTextMaxChars: 5,
      toolResultContentMaxChars: 4,
      maxToolResults: 1,
      maxFileEvents: 1,
    });

    expect(
      buildEvidencePacket(
        snapshot("Previous"),
        turnEvent(),
        [
          {
            source: "read_tool",
            path: "./a.ts",
            absolutePath: "/tmp/a.ts",
            timestamp: "2026-05-09T12:00:00.000Z",
            display: "read ./a.ts",
            previewTitle: "read ./a.ts",
            turnIndex: 7,
          },
        ],
        options,
      ),
    ).toMatchObject({
      turn: {
        turnIndex: 7,
        assistantText: "assis… [truncated 9 chars]",
        toolResults: [{ toolName: "read", isError: false, content: "tool… [truncated 8 chars]" }],
      },
      fileEvents: [{ path: "./a.ts", source: "read_tool" }],
    });
  });

  it("keeps only text content from array message parts", () => {
    const event = {
      ...turnEvent(),
      message: {
        ...turnEvent().message,
        content: [
          { type: "text", text: "first" },
          { type: "image", image: "ignored" },
          { type: "text", text: "second" },
        ],
      },
      toolResults: [
        {
          ...turnEvent().toolResults[0],
          content: [
            { type: "text", text: "tool first" },
            { type: "image", image: "ignored" },
            { type: "text", text: "tool second" },
          ],
        },
      ],
    } as TurnEndEvent;

    expect(buildEvidencePacket(snapshot("Previous"), event, [], resolveOptions())).toMatchObject({
      turn: {
        assistantText: "first\nsecond",
        toolResults: [{ content: "tool first\ntool second" }],
      },
    });
  });

  it("supports string content on assistant messages and tool results", () => {
    const event = {
      ...turnEvent(),
      message: { ...turnEvent().message, content: "assistant string" },
      toolResults: [{ ...turnEvent().toolResults[0], content: "tool string" }],
    } as unknown as TurnEndEvent;

    expect(buildEvidencePacket(snapshot("Previous"), event, [], resolveOptions())).toMatchObject({
      turn: {
        assistantText: "assistant string",
        toolResults: [{ content: "tool string" }],
      },
    });
  });

  it("keeps file event source, path, ranges, and display only", () => {
    expect(
      buildEvidencePacket(
        snapshot("Previous"),
        turnEvent(),
        [
          {
            source: "bash_output",
            path: "./a.ts",
            absolutePath: "/tmp/a.ts",
            startLine: 3,
            endLine: 5,
            timestamp: "2026-05-09T12:00:00.000Z",
            display: "./a.ts:3-5",
            detail: "detail omitted",
            previewTitle: "./a.ts:3-5",
            turnIndex: 7,
            toolCallId: "bash-1",
            command: "rg thing",
            rawCommand: "rg thing",
            matchedText: "thing",
          },
        ],
        resolveOptions(),
      ).fileEvents,
    ).toEqual([
      { path: "./a.ts", source: "bash_output", startLine: 3, endLine: 5, display: "./a.ts:3-5" },
    ]);
  });

  it("omits assistant text for non-assistant messages", () => {
    const event = {
      ...turnEvent(),
      message: { role: "user", content: "hello", timestamp: 0 },
    } as TurnEndEvent;

    expect(buildEvidencePacket(snapshot("Previous"), event, [], resolveOptions())).toMatchObject({
      turn: { assistantText: "" },
    });
  });
});

describe("taskContext", () => {
  it("registers turn handlers and writes snapshots from collected session file events", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));
    const sessionFile = path.join(dir, "session.jsonl");
    const sidecarPath = createSessionSidecarPath(sessionFile, "file-line-events.jsonl");
    const { pi, handlers } = createPi();
    const ctx = createContext(dir, sessionFile);
    completeSimpleMock.mockReset();
    completeSimpleMock.mockResolvedValue(modelResponse(snapshot("From Model")));
    await writeFile(
      sidecarPath,
      `${JSON.stringify({
        source: "read_tool",
        path: "./a.ts",
        absolutePath: path.join(dir, "a.ts"),
        timestamp: "2026-05-09T12:00:00.000Z",
        display: "read ./a.ts",
        previewTitle: "read ./a.ts",
        turnIndex: 7,
      })}\n`,
    );

    taskContext({ outputPath: "./task-context.jsonl" })(pi);
    await handlers.turn_start?.({ turnIndex: 7 }, ctx);
    await handlers.turn_end?.(turnEvent(), ctx);

    const request = completeSimpleMock.mock.calls[0]?.[1];
    const evidence = JSON.parse(request.messages[0].content[0].text);
    const onCalls = (pi.on as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(onCalls).toContainEqual(["turn_start", expect.any(Function)]);
    expect(onCalls).toContainEqual(["turn_end", expect.any(Function)]);
    expect(evidence).toMatchObject({
      previousSnapshot: { title: "" },
      fileEvents: [{ path: "./a.ts", source: "read_tool" }],
    });
    await expect(readLatestSnapshot(path.join(dir, "task-context.jsonl"))).resolves.toMatchObject({
      title: "From Model",
    });
  });

  it("notifies UI failures without throwing from turn_end", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));
    const { pi, handlers } = createPi();
    const ctx = createContext(dir, path.join(dir, "session.jsonl"));
    completeSimpleMock.mockReset();
    completeSimpleMock.mockRejectedValue(new Error("model failed"));

    taskContext({ outputPath: "./task-context.jsonl" })(pi);
    await expect(handlers.turn_end?.(turnEvent(), ctx)).resolves.toBeUndefined();

    const notifyCalls = (ctx.ui.notify as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(notifyCalls).toContainEqual(["task-context update failed: model failed", "warning"]);
  });
});

describe("updateTaskContextJsonl", () => {
  it("passes previous snapshot and bounded evidence to the snapshot completer", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));
    await writeFile(
      path.join(dir, "task-context.jsonl"),
      `${JSON.stringify(snapshot("Previous"))}\n`,
    );
    const runtime = { cwd: dir } as never;

    await updateTaskContextJsonl({
      runtime,
      turn: turnEvent(),
      fileEvents: [
        {
          source: "read_tool",
          path: "./a.ts",
          absolutePath: path.join(dir, "a.ts"),
          startLine: 2,
          endLine: 4,
          timestamp: "2026-05-09T12:00:00.000Z",
          display: "read ./a.ts:2-4",
          previewTitle: "read ./a.ts:2-4",
          turnIndex: 7,
        },
      ],
      options: resolveOptions({ outputPath: "./task-context.jsonl" }),
      completeSnapshot: async (evidence) => {
        expect(evidence).toMatchObject({
          previousSnapshot: { title: "Previous" },
          turn: { turnIndex: 7, assistantText: "assistant text" },
          fileEvents: [{ path: "./a.ts", startLine: 2, endLine: 4, display: "read ./a.ts:2-4" }],
        });
        return snapshot("Next");
      },
    });

    await expect(readLatestSnapshot(path.join(dir, "task-context.jsonl"))).resolves.toMatchObject({
      title: "Next",
    });
  });

  it("writes compact JSONL history and pretty current JSON", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));
    const runtime = { cwd: dir } as never;

    await updateTaskContextJsonl({
      runtime,
      turn: turnEvent(),
      fileEvents: [],
      options: resolveOptions({ outputPath: "./task-context.jsonl" }),
      completeSnapshot: async () => snapshot("Current"),
    });

    const history = await readFile(path.join(dir, "task-context.jsonl"), "utf8");
    const current = await readFile(path.join(dir, "task-context.json"), "utf8");

    expect(history).not.toContain("\n  ");
    expect(JSON.parse(history)).toMatchObject({
      title: "Current",
      autoUpdatedAt: expect.any(String),
    });
    expect(current).toContain('\n  "title": "Current",\n');
    expect(JSON.parse(current)).toMatchObject({
      title: "Current",
      autoUpdatedAt: expect.any(String),
    });
  });

  it("skips current snapshot writes when currentOutputPath is false", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));
    const runtime = { cwd: dir } as never;

    await updateTaskContextJsonl({
      runtime,
      turn: turnEvent(),
      fileEvents: [],
      options: resolveOptions({
        outputPath: "./nested/task-context.jsonl",
        currentOutputPath: false,
      }),
      completeSnapshot: async () => snapshot("No Current"),
    });

    await expect(
      readFile(path.join(dir, "nested", "task-context.jsonl"), "utf8"),
    ).resolves.toContain('"title":"No Current"');
    await expect(readFile(path.join(dir, "nested", "task-context.json"), "utf8")).rejects.toThrow();
  });

  it("writes custom current snapshot paths", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));
    const runtime = { cwd: dir } as never;

    await updateTaskContextJsonl({
      runtime,
      turn: turnEvent(),
      fileEvents: [],
      options: resolveOptions({
        outputPath: "./history/task-context.jsonl",
        currentOutputPath: "./current/context.json",
      }),
      completeSnapshot: async () => snapshot("Custom Current"),
    });

    await expect(readFile(path.join(dir, "current", "context.json"), "utf8")).resolves.toContain(
      '"title": "Custom Current"',
    );
  });

  it("returns the persisted snapshot with the supplied timestamp", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));
    const runtime = { cwd: dir } as never;
    const now = new Date("2026-05-09T13:14:15.000Z");

    const result = await updateTaskContextJsonl({
      runtime,
      turn: turnEvent(),
      fileEvents: [],
      options: resolveOptions({ outputPath: "./task-context.jsonl" }),
      now,
      completeSnapshot: async () => ({
        ...snapshot("Returned"),
        autoUpdatedAt: "1999-01-01T00:00:00.000Z",
      }),
    });

    expect(result).toMatchObject({ title: "Returned", autoUpdatedAt: now.toISOString() });
    await expect(readLatestSnapshot(path.join(dir, "task-context.jsonl"))).resolves.toMatchObject(
      result,
    );
  });

  it("leaves existing JSONL unchanged when model output is invalid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-task-context-test-"));
    const outputPath = path.join(dir, "task-context.jsonl");
    const original = `${JSON.stringify(snapshot("Current"))}\n`;
    await writeFile(outputPath, original);

    const runtime = { cwd: dir } as never;

    await expect(
      updateTaskContextJsonl({
        runtime,
        turn: turnEvent(),
        fileEvents: [],
        options: resolveOptions({ outputPath }),
        completeSnapshot: async () => ({ ...snapshot("Invalid"), extra: true }),
      }),
    ).rejects.toThrow();
    await expect(readFile(outputPath, "utf8")).resolves.toBe(original);
  });

  it("resolves relative output paths against cwd and expands home paths", () => {
    expect(resolveOutputPath("./overlay/task-context.jsonl", "/tmp/project")).toBe(
      "/tmp/project/overlay/task-context.jsonl",
    );
    expect(resolveOutputPath("/var/tmp/task-context.jsonl", "/tmp/project")).toBe(
      "/var/tmp/task-context.jsonl",
    );
    expect(resolveOutputPath("~", "/tmp/project")).toBe(os.homedir());
    expect(resolveOutputPath("~/task-context.jsonl", "/tmp/project")).toBe(
      path.join(os.homedir(), "task-context.jsonl"),
    );
  });

  it("derives current output path from JSONL and non-JSONL history paths", () => {
    expect(
      resolveCurrentOutputPath("./overlay/task-context.jsonl", undefined, "/tmp/project"),
    ).toBe("/tmp/project/overlay/task-context.json");
    expect(resolveCurrentOutputPath("./overlay/task-context", undefined, "/tmp/project")).toBe(
      "/tmp/project/overlay/task-context.current.json",
    );
    expect(resolveCurrentOutputPath("./overlay/task-context.jsonl", false, "/tmp/project")).toBe(
      undefined,
    );
  });

  it("resolves custom current output paths", () => {
    expect(resolveCurrentOutputPath("./history.jsonl", "./current.json", "/tmp/project")).toBe(
      "/tmp/project/current.json",
    );
    expect(resolveCurrentOutputPath("./history.jsonl", "~/current.json", "/tmp/project")).toBe(
      path.join(os.homedir(), "current.json"),
    );
  });
});
