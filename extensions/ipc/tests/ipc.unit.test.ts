import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, onTestFinished, test as testCases, vi } from "vitest";

import {
  CHILD_ENV,
  compactAssistantMessageEvent,
  createLiveEventWriter,
  createPiSessionStatusWriter,
  eventKey,
  ipc,
  liveEventStreamPath,
  MESSAGE_TYPE,
  PARENT_SESSION_ENV,
  parseEnvelope,
  parseLiveEventRecord,
  parsePiSessionStatus,
  piSessionStatusPath,
  parseUserMessageRequest,
  probePiSession,
  RECEIPT_TYPE,
  sendEnvelope,
  sendUserMessage,
  socketPathForSession,
  startReceiver,
  TASK_SLUG_ENV,
  truncatePiJqOutput,
  type DelegateSettledEnvelope,
  type IpcOptions,
  type LiveEventRecord,
  type UserMessageInput,
  type UserMessageRequest,
} from "../src/extension";
import { loadConfigOrDefault } from "@richardgill/pi-config";

import { DEFAULT_IPC_CONFIG, IpcConfigSchema } from "../src/config";
import { sendAbort, sendSetModel, sendSetThinkingLevel } from "../src/protocol";
import { createPiSessionStatusSource, listPiSessionStatuses } from "../src/session-status";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type SentMessage = { message: unknown; options: unknown };
type FakePi = {
  api: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  receipts: { customType: string; data: unknown }[];
  messages: SentMessage[];
  userMessages: SentMessage[];
  renderers: Map<string, MessageRenderer<unknown>>;
  exec: ReturnType<typeof vi.fn>;
};

const tempDirs: string[] = [];
const originalConfigDir = process.env.PI_EXTENSION_CONFIG_DIR;

const createTempDir = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ipc-test-"));
  tempDirs.push(directory);
  return directory;
};

const envelope = (overrides: Partial<DelegateSettledEnvelope> = {}): DelegateSettledEnvelope => ({
  childSessionId: randomUUID(),
  taskSlug: "child-task",
  leafId: randomUUID(),
  cwd: "/tmp/project",
  timestamp: Date.now(),
  ...overrides,
});

const createPi = (
  execResult: ExecResult = {
    stdout: "task complete",
    stderr: "",
    code: 0,
    killed: false,
  },
): FakePi => {
  const handlers = new Map<string, Handler[]>();
  const receipts: { customType: string; data: unknown }[] = [];
  const messages: SentMessage[] = [];
  const userMessages: SentMessage[] = [];
  const renderers = new Map<string, MessageRenderer<unknown>>();
  const exec = vi.fn(async () => execResult);
  const api = {
    exec,
    on: (event: string, handler: Handler) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: (customType: string, data: unknown) => receipts.push({ customType, data }),
    registerMessageRenderer: (customType: string, renderer: MessageRenderer<unknown>) =>
      renderers.set(customType, renderer),
    sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
    sendUserMessage: (message: unknown, options: unknown) =>
      userMessages.push({ message, options }),
    getThinkingLevel: () => "medium",
  } as unknown as ExtensionAPI;

  return { api, handlers, receipts, messages, userMessages, renderers, exec };
};

const createContext = ({
  idle = true,
  entries = [],
  sessionId = randomUUID(),
  leafId = randomUUID(),
  sessionFile = "/tmp/session.jsonl",
}: {
  idle?: boolean;
  entries?: unknown[];
  sessionId?: string;
  leafId?: string;
  sessionFile?: string;
} = {}): ExtensionContext =>
  ({
    cwd: "/tmp/project",
    getContextUsage: () => undefined,
    isIdle: () => idle,
    abort: () => undefined,
    model: { provider: "provider", id: "model-1", name: "Model One" },
    modelRegistry: {
      getAll: () => [
        { provider: "provider", id: "model-1", name: "Model One" },
        { provider: "provider", id: "model-2", name: "Model Two" },
      ],
      getAvailable: () => [],
    },
    scopedModels: [],
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => sessionId,
      getLeafId: () => leafId,
      getSessionFile: () => sessionFile,
    },
  }) as unknown as ExtensionContext;

const emit = async (
  fake: FakePi,
  event: string,
  ctx: ExtensionContext,
  value: unknown = {},
): Promise<void> => {
  for (const handler of fake.handlers.get(event) ?? []) {
    await handler(value, ctx);
  }
};

type ParentHarnessOptions = {
  idle?: boolean;
  entries?: unknown[];
  sessionId?: string;
  leafId?: string;
  sessionFile?: string;
  env?: NodeJS.ProcessEnv;
  execResult?: ExecResult;
  configureFake?: (fake: FakePi) => void;
  ipcOptions?: Omit<IpcOptions, "env" | "runtimeDir">;
};

const startParentHarness = async ({
  idle,
  entries,
  sessionId = randomUUID(),
  leafId,
  sessionFile,
  env = {},
  execResult,
  configureFake,
  ipcOptions,
}: ParentHarnessOptions = {}) => {
  const runtimeDir = await createTempDir();
  const fake = createPi(execResult);
  configureFake?.(fake);
  const ctx = createContext({ idle, entries, sessionId, leafId, sessionFile });
  const socketPath = socketPathForSession(sessionId, runtimeDir);
  ipc(fake.api, { env, runtimeDir, ...ipcOptions });
  await emit(fake, "session_start", ctx, {
    type: "session_start",
    reason: "startup",
  });

  return {
    runtimeDir,
    sessionId,
    socketPath,
    env,
    fake,
    ctx,
    send: (value: DelegateSettledEnvelope, options: Parameters<typeof sendEnvelope>[2] = {}) =>
      sendEnvelope(socketPath, value, options),
    sendUserMessage: (request: UserMessageInput) =>
      sendUserMessage(sessionId, request, { runtimeDir }),
    shutdown: () =>
      emit(fake, "session_shutdown", ctx, {
        type: "session_shutdown",
        reason: "quit",
      }),
  };
};

const renderFriendlyNotification = (taskSlug: string): string[] => {
  const fake = createPi();
  const value = envelope({ taskSlug });
  ipc(fake.api, { env: {} });
  const renderer = fake.renderers.get(MESSAGE_TYPE);
  if (!renderer) {
    throw new Error("Delegate message renderer was not registered");
  }

  const component = renderer(
    {
      role: "custom",
      customType: MESSAGE_TYPE,
      content: "model-only content",
      display: true,
      details: { ...value, output: "task complete" },
      timestamp: 0,
    },
    { expanded: false, outputPad: 0 },
    {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    } as never,
  );
  return component?.render(200).map((line) => line.trimEnd()) ?? [];
};

const rawExchange = (socketPath: string, chunks: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const response: Buffer[] = [];
    socket.on("connect", () => {
      chunks.forEach((chunk) => socket.write(chunk));
      socket.end();
    });
    socket.on("data", (chunk: Buffer) => response.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(response).toString("utf8")));
    socket.on("error", reject);
  });

afterEach(async () => {
  if (originalConfigDir === undefined) {
    Reflect.deleteProperty(process.env, "PI_EXTENSION_CONFIG_DIR");
  } else {
    process.env.PI_EXTENSION_CONFIG_DIR = originalConfigDir;
  }
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("parseEnvelope", () => {
  testCases.each([
    ["non-JSON", "nope"],
    ["an array", "[]"],
    ["an unexpected envelope field", JSON.stringify({ ...envelope(), extra: "value" })],
    ["a missing session ID", JSON.stringify({ ...envelope(), childSessionId: undefined })],
    ["a missing task slug", JSON.stringify({ ...envelope(), taskSlug: undefined })],
    ["an invalid task slug", JSON.stringify(envelope({ taskSlug: "bad slug" }))],
    ["an invalid timestamp", JSON.stringify(envelope({ timestamp: -1 }))],
    ["an oversized cwd", JSON.stringify(envelope({ cwd: "x".repeat(2049) }))],
    ["an oversized frame", "x".repeat(4097)],
  ])("rejects %s", (_name, input) => {
    expect(parseEnvelope(input)).toBeUndefined();
  });

  it("accepts a valid envelope", () => {
    const value = envelope();
    expect(parseEnvelope(JSON.stringify(value))).toEqual(value);
  });
});

describe("parseUserMessageRequest", () => {
  const request = (overrides: Partial<UserMessageRequest> = {}): UserMessageRequest => ({
    version: 1,
    requestId: randomUUID(),
    type: "user_message",
    message: "Review this",
    deliverAs: "steer",
    expandPromptTemplates: true,
    ...overrides,
  });

  it("defaults prompt expansion and rejects malformed requests", () => {
    const { expandPromptTemplates: _expandPromptTemplates, ...withoutExpansion } = request();
    expect(parseUserMessageRequest(JSON.stringify(withoutExpansion))).toEqual({
      ...withoutExpansion,
      expandPromptTemplates: true,
    });
    expect(parseUserMessageRequest(JSON.stringify(request({ message: " " })))).toBeUndefined();
    expect(
      parseUserMessageRequest(JSON.stringify(request({ requestId: "bad id" }))),
    ).toBeUndefined();
    expect(
      parseUserMessageRequest(JSON.stringify(request({ message: "x".repeat(3073) }))),
    ).toBeUndefined();
    expect(
      parseUserMessageRequest(JSON.stringify({ ...request(), unexpected: true })),
    ).toBeUndefined();
  });
});

describe("pi-ipc configuration", () => {
  it("uses the documented defaults", () => {
    expect(IpcConfigSchema.parse({})).toEqual(DEFAULT_IPC_CONFIG);
  });

  it("discovers and parses JSONC from the extension config directory", async () => {
    const directory = await createTempDir();
    process.env.PI_EXTENSION_CONFIG_DIR = directory;
    await writeFile(
      join(directory, "ipc.jsonc"),
      '{\n  // Local stream\n  "liveEventsDir": "/tmp/events",\n}\n',
    );

    expect(
      loadConfigOrDefault({
        filename: "ipc.jsonc",
        schema: IpcConfigSchema,
      }),
    ).toEqual({
      ...DEFAULT_IPC_CONFIG,
      liveEventsDir: "/tmp/events",
    });
  });

  it("keeps the child session placeholder in a custom inspection command", async () => {
    const directory = await createTempDir();
    process.env.PI_EXTENSION_CONFIG_DIR = directory;
    await writeFile(
      join(directory, "ipc.jsonc"),
      '{"inspectionCommand":["inspect-child","{{childSessionId}}"]}',
    );

    expect(
      loadConfigOrDefault({
        filename: "ipc.jsonc",
        schema: IpcConfigSchema,
      }).inspectionCommand,
    ).toEqual(["inspect-child", "{{childSessionId}}"]);
  });

  it("rejects unknown inspection command template variables", async () => {
    const directory = await createTempDir();
    process.env.PI_EXTENSION_CONFIG_DIR = directory;
    await writeFile(
      join(directory, "ipc.jsonc"),
      '{"inspectionCommand":["inspect-child","{{childSessionId}}","{{sessionId}}"]}',
    );

    expect(() =>
      loadConfigOrDefault({
        filename: "ipc.jsonc",
        schema: IpcConfigSchema,
      }),
    ).toThrow('config.inspectionCommand.2 uses unknown template variable "sessionId"');
  });

  it("requires an absolute live event directory when enabled", () => {
    expect(() => IpcConfigSchema.parse({ liveEventsDir: "relative/events" })).toThrow(
      "must be an absolute path",
    );
  });

  testCases.each([
    [[], "no placeholder"],
    [["pi-jq", "{{childSessionId}}", "{{childSessionId}}"], "two placeholders"],
    [["pi-jq", "{{sessionId}}"], "an unknown placeholder"],
    [["pi-jq", "{{childSessionId}}"], "a timeout above the bound", 60_001],
  ])("rejects %s", (inspectionCommand, _name, inspectionTimeoutMs?: number) => {
    expect(() => IpcConfigSchema.parse({ inspectionCommand, inspectionTimeoutMs })).toThrow();
  });
});

describe("live event stream", () => {
  const readRecords = async (filePath: string): Promise<LiveEventRecord[]> => {
    const content = await readFile(filePath, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    return content
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as LiveEventRecord);
  };

  it("validates status snapshots and safe stream paths", () => {
    const rootDir = "/tmp/events";
    const status = {
      version: 1 as const,
      sessionId: "session-1",
      sessionFile: "/sessions/session-1.jsonl",
      streamId: "stream-1",
      processInstanceId: "process-1",
      pid: 123,
      hostname: "host",
      startedAt: 1,
      updatedAt: 2,
      state: "idle" as const,
      thinkingLevel: "medium",
    };

    expect(parsePiSessionStatus(status)).toEqual(status);
    expect(parsePiSessionStatus({ ...status, state: "unknown" })).toBeUndefined();
    expect(piSessionStatusPath(rootDir, "session-1", "stream-1")).toBe(
      "/tmp/events/session-1/stream-1.status.json",
    );
    expect(() => piSessionStatusPath(rootDir, "../session", "stream")).toThrow(
      "Invalid session ID",
    );
  });

  it("atomically replaces serialized status updates with private permissions", async () => {
    const rootDir = await createTempDir();
    const writer = createPiSessionStatusWriter({
      rootDir,
      status: {
        sessionId: "session-1",
        sessionFile: "/sessions/session-1.jsonl",
        streamId: "stream-1",
        processInstanceId: "process-1",
        pid: 123,
        hostname: "host",
        startedAt: 1,
        state: "idle",
        thinkingLevel: "medium",
      },
    });

    await Promise.all([writer.update({ state: "busy" }), writer.update({ thinkingLevel: "high" })]);
    expect(parsePiSessionStatus(JSON.parse(await readFile(writer.filePath, "utf8")))).toMatchObject(
      { state: "busy", thinkingLevel: "high" },
    );
    expect((await stat(writer.filePath)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(rootDir, "session-1"))).toEqual(["stream-1.status.json"]);

    await writer.close();
    expect(parsePiSessionStatus(JSON.parse(await readFile(writer.filePath, "utf8")))).toMatchObject(
      { state: "stopped" },
    );
  });

  it("selects the newest live stream and filters stopped or dead local processes", async () => {
    const rootDir = await createTempDir();
    const streams = [
      {
        sessionId: "live",
        streamId: "old",
        processInstanceId: "previous",
        pid: 123,
        stopped: false,
      },
      {
        sessionId: "live",
        streamId: "new",
        processInstanceId: "current",
        pid: 124,
        stopped: false,
      },
      {
        sessionId: "stopped",
        streamId: "before-stop",
        processInstanceId: "finished",
        pid: 125,
        stopped: false,
      },
      {
        sessionId: "stopped",
        streamId: "after-stop",
        processInstanceId: "finished",
        pid: 125,
        stopped: true,
      },
      { sessionId: "dead", streamId: "dead", processInstanceId: "dead", pid: 999, stopped: false },
    ];
    const writers = streams.map(({ stopped, ...identity }, index) => ({
      stopped,
      writer: createPiSessionStatusWriter({
        rootDir,
        status: {
          ...identity,
          sessionFile: `/sessions/${identity.sessionId}.jsonl`,
          hostname: "host",
          startedAt: index,
          state: "idle",
          thinkingLevel: "off",
        },
      }),
    }));
    await Promise.all(
      writers.map(({ stopped, writer }) => (stopped ? writer.close() : writer.update({}))),
    );

    await expect(
      listPiSessionStatuses({ rootDir, hostname: "host", pidAlive: (pid) => pid !== 999 }),
    ).resolves.toEqual([expect.objectContaining({ sessionId: "live", streamId: "new" })]);
  });

  it("invalidates status subscribers when a session appears", async () => {
    const rootDir = await createTempDir();
    const source = createPiSessionStatusSource({ rootDir, hostname: "host", pidAlive: () => true });
    const controller = new AbortController();
    onTestFinished(() => controller.abort());
    const invalidate = vi.fn();
    source.subscribe(invalidate, { signal: controller.signal });
    await expect.poll(() => invalidate.mock.calls.length).toBeGreaterThan(0);
    invalidate.mockClear();

    const writer = createPiSessionStatusWriter({
      rootDir,
      status: {
        sessionId: "agent",
        sessionFile: "/sessions/agent.jsonl",
        streamId: "stream",
        processInstanceId: "process",
        hostname: "host",
        pid: 123,
        startedAt: 1,
        state: "idle",
        thinkingLevel: "off",
      },
    });
    await writer.update({});

    await expect.poll(() => invalidate.mock.calls.length).toBeGreaterThan(0);
    await expect(source.list()).resolves.toEqual([expect.objectContaining({ sessionId: "agent" })]);
  });

  it("writes complete records in sequence and closes with the shutdown event", async () => {
    const rootDir = await createTempDir();
    const sessionId = randomUUID();
    const streamId = randomUUID();
    const writer = createLiveEventWriter({
      rootDir,
      sessionId,
      streamId,
      processInstanceId: "process-1",
    });

    writer.append({ type: "agent_start" });
    writer.append({ type: "turn_start", turnIndex: 0, timestamp: 123 });
    await writer.close({ type: "session_shutdown", reason: "quit" });
    writer.append({ type: "agent_settled" });

    expect(writer.filePath).toBe(liveEventStreamPath(rootDir, sessionId, streamId));
    const records = await readRecords(writer.filePath);
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect(records.map((record) => record.event.type)).toEqual([
      "agent_start",
      "turn_start",
      "session_shutdown",
    ]);
    expect(records).toEqual(
      records.map((record) => ({
        ...record,
        version: 1,
        sessionId,
        processInstanceId: "process-1",
        streamId,
      })),
    );
    expect(parseLiveEventRecord(records[0], sessionId)).toEqual(records[0]);
    expect(parseLiveEventRecord(records[0], randomUUID())).toBeUndefined();
  });

  it("keeps assistant deltas but removes cumulative partial messages", () => {
    const partial = {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    };
    const event = {
      type: "text_delta",
      contentIndex: 0,
      delta: " world",
      partial,
    } as Parameters<typeof compactAssistantMessageEvent>[0];

    expect(compactAssistantMessageEvent(event)).toEqual({
      type: "text_delta",
      contentIndex: 0,
      delta: " world",
    });
    expect(
      compactAssistantMessageEvent({
        type: "text_end",
        contentIndex: 0,
        content: "Hello world",
        partial,
      } as Parameters<typeof compactAssistantMessageEvent>[0]),
    ).toEqual({ type: "text_end", contentIndex: 0 });
  });

  it("captures message lifecycle across reload streams without cumulative updates", async () => {
    const liveEventsDir = await createTempDir();
    const harness = await startParentHarness({
      sessionFile: "/canonical/pi-session.jsonl",
      ipcOptions: { liveEventsDir },
    });
    const assistantStart = {
      type: "message_start",
      message: { role: "assistant", content: [], timestamp: 1 },
    };
    await emit(harness.fake, "message_start", harness.ctx, assistantStart);
    await emit(harness.fake, "message_update", harness.ctx, {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        timestamp: 1,
      },
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Hello",
        partial: {
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
          timestamp: 1,
        },
      },
    });
    await emit(harness.fake, "message_end", harness.ctx, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        timestamp: 1,
      },
    });
    await harness.shutdown();

    const sessionId = harness.ctx.sessionManager.getSessionId();
    const streamFile = (await readdir(join(liveEventsDir, sessionId))).find((file) =>
      file.endsWith(".jsonl"),
    );
    const records = await readRecords(join(liveEventsDir, sessionId, streamFile!));
    const update = records.find((record) => record.event.type === "message_update");
    expect(update?.event).toMatchObject({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    expect(update?.event).not.toHaveProperty("message");
    expect(update?.event).not.toHaveProperty("assistantMessageEvent.partial");
    expect(records.at(0)?.event).toMatchObject({
      type: "session_start",
      reason: "startup",
    });
    expect(records.at(-1)?.event).toEqual({
      type: "session_shutdown",
      reason: "quit",
    });
  });

  it("publishes initial and lifecycle status without waiting for a message", async () => {
    const liveEventsDir = await createTempDir();
    const harness = await startParentHarness({
      env: { TMUX_PANE: "%42" },
      sessionFile: "/canonical/pi-session.jsonl",
      ipcOptions: { liveEventsDir },
    });
    let usage = { tokens: 10, contextWindow: 100, percent: 10 };
    Object.assign(harness.ctx, {
      model: { provider: "provider", id: "model-1", name: "Model One" },
      thinkingLevel: "high",
      getContextUsage: () => usage,
    });
    const sessionDir = join(liveEventsDir, harness.sessionId);
    const statusFile = (await readdir(sessionDir)).find((file) => file.endsWith(".status.json"));
    const readStatus = async () =>
      parsePiSessionStatus(JSON.parse(await readFile(join(sessionDir, statusFile!), "utf8")));

    expect(await readStatus()).toMatchObject({
      sessionId: harness.sessionId,
      sessionFile: "/canonical/pi-session.jsonl",
      tmuxPane: "%42",
      state: "idle",
      thinkingLevel: "medium",
      model: { provider: "provider", id: "model-1", name: "Model One" },
      modelOptions: [
        { provider: "provider", id: "model-1", name: "Model One" },
        { provider: "provider", id: "model-2", name: "Model Two" },
      ],
    });
    await emit(harness.fake, "agent_start", harness.ctx, {
      type: "agent_start",
    });
    expect(await readStatus()).toMatchObject({
      state: "busy",
      contextUsage: usage,
    });
    await emit(harness.fake, "model_select", harness.ctx, {
      type: "model_select",
      source: "set",
      model: { provider: "provider", id: "model-2", name: "Model Two" },
    });
    await emit(harness.fake, "thinking_level_select", harness.ctx, {
      type: "thinking_level_select",
      level: "xhigh",
      previousLevel: "high",
    });
    usage = { tokens: 50, contextWindow: 100, percent: 50 };
    await emit(harness.fake, "turn_end", harness.ctx, {
      type: "turn_end",
      turnIndex: 0,
    });
    expect(await readStatus()).toMatchObject({
      contextUsage: usage,
      model: { provider: "provider", id: "model-2", name: "Model Two" },
      thinkingLevel: "xhigh",
    });
    await emit(harness.fake, "agent_settled", harness.ctx, {
      type: "agent_settled",
    });
    expect(await readStatus()).toMatchObject({ state: "idle" });

    await harness.shutdown();
    expect(await readStatus()).toMatchObject({ state: "stopped" });
  });

  it("segments reloads and session replacements into identifiable streams", async () => {
    const liveEventsDir = await createTempDir();
    const runtimeDir = await createTempDir();
    const fake = createPi();
    const firstSessionId = randomUUID();
    const firstCtx = createContext({
      sessionId: firstSessionId,
      sessionFile: "/canonical/first.jsonl",
    });
    ipc(fake.api, { env: {}, runtimeDir, liveEventsDir });

    await emit(fake, "session_start", firstCtx, {
      type: "session_start",
      reason: "startup",
    });
    await emit(fake, "session_shutdown", firstCtx, {
      type: "session_shutdown",
      reason: "reload",
    });
    await emit(fake, "session_start", firstCtx, {
      type: "session_start",
      reason: "reload",
    });
    await emit(fake, "session_shutdown", firstCtx, {
      type: "session_shutdown",
      reason: "resume",
      targetSessionFile: "/canonical/second.jsonl",
    });

    const secondSessionId = randomUUID();
    const secondCtx = createContext({
      sessionId: secondSessionId,
      sessionFile: "/canonical/second.jsonl",
    });
    await emit(fake, "session_start", secondCtx, {
      type: "session_start",
      reason: "resume",
      previousSessionFile: "/canonical/first.jsonl",
    });
    await emit(fake, "session_shutdown", secondCtx, {
      type: "session_shutdown",
      reason: "quit",
    });

    const firstFiles = (await readdir(join(liveEventsDir, firstSessionId))).filter((file) =>
      file.endsWith(".jsonl"),
    );
    const secondFiles = (await readdir(join(liveEventsDir, secondSessionId))).filter((file) =>
      file.endsWith(".jsonl"),
    );
    expect(firstFiles).toHaveLength(2);
    expect(secondFiles).toHaveLength(1);

    const streams = await Promise.all(
      [
        ...firstFiles.map((file) => join(liveEventsDir, firstSessionId, file)),
        ...secondFiles.map((file) => join(liveEventsDir, secondSessionId, file)),
      ].map(readRecords),
    );
    expect(new Set(streams.map((records) => records[0]?.processInstanceId)).size).toBe(1);
    expect(new Set(streams.map((records) => records[0]?.streamId)).size).toBe(3);
    streams.forEach((records) => {
      expect(records.map((record) => record.sequence)).toEqual([1, 2]);
      expect(records[0]?.event.type).toBe("session_start");
      expect(records[1]?.event.type).toBe("session_shutdown");
    });
  });

  it("isolates write failures from the caller", async () => {
    const directory = await createTempDir();
    const rootDir = join(directory, "not-a-directory");
    await writeFile(rootDir, "file");
    const errors: unknown[] = [];
    const writer = createLiveEventWriter({
      rootDir,
      sessionId: randomUUID(),
      onError: (error) => errors.push(error),
    });

    writer.append({ type: "agent_start" });
    await expect(
      writer.close({ type: "session_shutdown", reason: "quit" }),
    ).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("Unix socket protocol", () => {
  it("uses connection end as framing and returns a validated ACK", async () => {
    const directory = await createTempDir();
    const socketPath = join(directory, "s");
    const received: DelegateSettledEnvelope[] = [];
    const value = envelope();
    const payload = JSON.stringify(value);
    const receiver = await startReceiver(socketPath, (message) => received.push(message));

    const ack = await rawExchange(socketPath, [payload.slice(0, 10), payload.slice(10)]);

    expect(ack).toBe("ACK");
    expect(received).toEqual([value]);
    await receiver.close();
  });

  it("probes active sessions through the shared protocol", async () => {
    const directory = await createTempDir();
    const sessionId = randomUUID();
    const socketPath = socketPathForSession(sessionId, directory);
    const receiver = await startReceiver(socketPath, () => undefined);

    await expect(probePiSession(sessionId, { runtimeDir: directory })).resolves.toBe(true);
    await receiver.close();
    await expect(probePiSession(sessionId, { runtimeDir: directory })).resolves.toBe(false);
    await expect(probePiSession("bad id", { runtimeDir: directory })).resolves.toBe(false);
  });

  it("does not ACK malformed input", async () => {
    const directory = await createTempDir();
    const socketPath = join(directory, "s");
    const received: DelegateSettledEnvelope[] = [];
    const receiver = await startReceiver(socketPath, (message) => received.push(message));

    expect(await rawExchange(socketPath, ["{}"])).toBe("");
    expect(received).toEqual([]);
    await receiver.close();
  });

  it("refuses to steal a live socket", async () => {
    const directory = await createTempDir();
    const socketPath = join(directory, "s");
    const receiver = await startReceiver(socketPath, () => undefined);

    await expect(startReceiver(socketPath, () => undefined)).rejects.toThrow("already active");

    await receiver.close();
  });

  it("removes a socket left by a hard crash", async () => {
    const directory = await createTempDir();
    const socketPath = join(directory, "s");
    const script =
      "const net=require('node:net');net.createServer().listen(process.argv[1],()=>console.log('ready'))";
    const child = spawn(process.execPath, ["-e", script, socketPath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await once(child.stdout!, "data");
    child.kill("SIGKILL");
    await once(child, "exit");
    await expect(access(socketPath)).resolves.toBeUndefined();

    const receiver = await startReceiver(socketPath, () => undefined);

    await receiver.close();
  });

  it("closes a client that does not finish its frame", async () => {
    const directory = await createTempDir();
    const socketPath = join(directory, "s");
    const receiver = await startReceiver(socketPath, () => undefined, 20);
    const stalled = createConnection(socketPath);
    await once(stalled, "connect");

    await once(stalled, "close");

    await receiver.close();
  });

  it("retries a startup race and bounds connection failure", async () => {
    const directory = await createTempDir();
    const socketPath = join(directory, "s");
    const value = envelope();
    let receiver: Awaited<ReturnType<typeof startReceiver>> | undefined;
    const start = setTimeout(() => {
      void startReceiver(socketPath, () => undefined).then((started) => {
        receiver = started;
      });
    }, 20);

    await expect(
      sendEnvelope(socketPath, value, {
        ackTimeoutMs: 30,
        retryDelaysMs: [0, 40, 80],
      }),
    ).resolves.toBe(true);
    clearTimeout(start);
    await receiver?.close();

    await expect(
      sendEnvelope(join(directory, "missing"), value, {
        ackTimeoutMs: 10,
        retryDelaysMs: [0, 1],
      }),
    ).resolves.toBe(false);
  });
});

describe("socket paths and event keys", () => {
  it("derives the same short path from a session ID", () => {
    const sessionId = randomUUID();
    expect(socketPathForSession(sessionId)).toBe(socketPathForSession(sessionId));
    expect(Buffer.byteLength(socketPathForSession(sessionId))).toBeLessThanOrEqual(100);
  });

  it("rejects invalid IDs and long runtime paths", () => {
    expect(() => socketPathForSession("bad id")).toThrow("Invalid Pi session ID");
    expect(() => socketPathForSession(randomUUID(), `/${"x".repeat(100)}`)).toThrow(
      "exceeds 100 bytes",
    );
  });

  it("derives one event key per child leaf", () => {
    const value = envelope();
    expect(eventKey(value)).toBe(eventKey(value));
    expect(eventKey({ ...value, leafId: randomUUID() })).not.toBe(eventKey(value));
  });
});

describe("inbound user messages", () => {
  it("delivers immediately when idle and forwards the default expansion flag", async () => {
    const harness = await startParentHarness({ idle: true });
    const requestId = randomUUID();

    await expect(
      harness.sendUserMessage({
        requestId,
        message: "Use /review",
        deliverAs: "steer",
      }),
    ).resolves.toEqual({
      version: 1,
      requestId,
      ok: true,
      delivery: "immediate",
    });
    expect(harness.fake.userMessages).toEqual([
      { message: "Use /review", options: { expandPromptTemplates: true } },
    ]);
    await harness.shutdown();
  });

  testCases.each([
    ["steers after the current turn", "steer"],
    ["follows up after the agent run", "followUp"],
  ])("%s while busy", async (_name, deliverAs) => {
    if (deliverAs !== "steer" && deliverAs !== "followUp") {
      throw new Error("Invalid delivery mode");
    }
    const harness = await startParentHarness({ idle: false });
    const requestId = randomUUID();

    await expect(
      harness.sendUserMessage({
        requestId,
        message: "Continue",
        deliverAs,
        expandPromptTemplates: false,
      }),
    ).resolves.toEqual({
      version: 1,
      requestId,
      ok: true,
      delivery: deliverAs,
    });
    expect(harness.fake.userMessages).toEqual([
      {
        message: "Continue",
        options: { deliverAs, expandPromptTemplates: false },
      },
    ]);
    await harness.shutdown();
  });

  it("deduplicates request IDs and ignores malformed or oversized frames", async () => {
    const harness = await startParentHarness();
    const requestId = randomUUID();
    const request = {
      requestId,
      message: "Once",
      deliverAs: "steer" as const,
    };

    await harness.sendUserMessage(request);
    await harness.sendUserMessage(request);
    expect(harness.fake.userMessages).toHaveLength(1);
    expect(await rawExchange(harness.socketPath, ["{}"]).then((response) => response)).toBe("");
    expect(await rawExchange(harness.socketPath, ["x".repeat(4097)])).toBe("");
    await harness.shutdown();
  });

  it("rejects stale requests after shutdown without using Pi APIs", async () => {
    const harness = await startParentHarness();
    const requestId = randomUUID();
    await harness.shutdown();

    await expect(
      sendUserMessage(
        harness.sessionId,
        {
          requestId,
          message: "Too late",
          deliverAs: "steer",
        },
        { runtimeDir: harness.runtimeDir },
      ),
    ).resolves.toBeUndefined();
    expect(harness.fake.userMessages).toEqual([]);
  });
});

describe("inbound session controls", () => {
  testCases.each([
    { idle: true, result: { ok: false, error: "unavailable" }, calls: 0 },
    { idle: false, result: { ok: true }, calls: 1 },
  ])("responds to abort when idle=$idle", async ({ idle, result, calls }) => {
    const { ctx, runtimeDir, sessionId, shutdown } = await startParentHarness({ idle });
    onTestFinished(shutdown);
    const abort = vi.spyOn(ctx, "abort");
    const request = { requestId: randomUUID() };
    const expected = { version: 1, ...request, ...result };
    await expect(sendAbort(sessionId, request, { runtimeDir })).resolves.toEqual(expected);
    await expect(sendAbort(sessionId, request, { runtimeDir })).resolves.toEqual(expected);
    expect(abort).toHaveBeenCalledTimes(calls);
  });

  testCases.each([
    { found: false, authenticated: false, result: { ok: false, error: "not_found" }, calls: 0 },
    { found: true, authenticated: false, result: { ok: false, error: "no_key" }, calls: 1 },
    { found: true, authenticated: true, result: { ok: true }, calls: 1 },
  ])(
    "selects models when found=$found authenticated=$authenticated",
    async ({ found, authenticated, result, calls }) => {
      const setModel = vi.fn(async () => authenticated);
      const { ctx, runtimeDir, sessionId, shutdown } = await startParentHarness({
        configureFake: ({ api }) => {
          api.setModel = setModel;
        },
      });
      onTestFinished(shutdown);
      const model = ctx.model!;
      const find = vi.fn(() => (found ? model : undefined));
      ctx.modelRegistry.find = find;
      const request = { requestId: randomUUID(), provider: model.provider, id: model.id };
      const expected = { version: 1, requestId: request.requestId, ...result };
      await expect(sendSetModel(sessionId, request, { runtimeDir })).resolves.toEqual(expected);
      await expect(sendSetModel(sessionId, request, { runtimeDir })).resolves.toEqual(expected);
      expect(find).toHaveBeenCalledExactlyOnceWith(model.provider, model.id);
      expect(setModel).toHaveBeenCalledTimes(calls);
    },
  );

  it("changes the thinking level once per request ID", async () => {
    const setThinkingLevel = vi.fn();
    const { runtimeDir, sessionId, shutdown } = await startParentHarness({
      configureFake: ({ api }) => {
        api.setThinkingLevel = setThinkingLevel;
      },
    });
    onTestFinished(shutdown);
    const request = { requestId: randomUUID(), level: "high" as const };
    const expected = { version: 1, requestId: request.requestId, ok: true };
    await expect(sendSetThinkingLevel(sessionId, request, { runtimeDir })).resolves.toEqual(
      expected,
    );
    await expect(sendSetThinkingLevel(sessionId, request, { runtimeDir })).resolves.toEqual(
      expected,
    );
    expect(setThinkingLevel).toHaveBeenCalledExactlyOnceWith("high");
  });
});

describe("pi-jq output", () => {
  it("keeps the last 2000 lines", () => {
    const sessionId = randomUUID();
    const output = Array.from({ length: 2001 }, (_, index) => `line-${index}`).join("\n");

    const truncated = truncatePiJqOutput(output, sessionId, DEFAULT_IPC_CONFIG);

    expect(truncated.startsWith("line-1\n")).toBe(true);
    expect(truncated).toContain("showing last 2000 of 2001 lines");
    expect(truncated).toContain(
      `Full output: "pi-jq" "${sessionId}" "--messages" "3" "--role" "assistant"`,
    );
  });

  it("keeps at most 50KB of output", () => {
    const sessionId = randomUUID();
    const truncated = truncatePiJqOutput("x".repeat(60 * 1024), sessionId, DEFAULT_IPC_CONFIG);
    const [output = ""] = truncated.split("\n\n[Output truncated:");

    expect(Buffer.byteLength(output)).toBe(50 * 1024);
    expect(truncated).toContain("50.0KB of 60.0KB");
  });
});

describe("extension lifecycle", () => {
  testCases.each([
    [
      "notify-review",
      [
        "<muted>[</muted><accent>notify-review</accent><muted> finished]</muted>",
        "",
        "task complete",
      ],
    ],
    [
      "task-2",
      ["<muted>[</muted><accent>task-2</accent><muted> finished]</muted>", "", "task complete"],
    ],
  ])("renders a friendly notification for slug=%s", (taskSlug, expectedLines) => {
    expect(renderFriendlyNotification(taskSlug)).toEqual(expectedLines);
  });

  testCases.each([
    [true, { triggerTurn: true }],
    [false, { deliverAs: "steer" }],
  ])("delivers once with idle=%s", async (idle, expectedOptions) => {
    const harness = await startParentHarness({ idle });
    const value = envelope();

    expect(harness.env[PARENT_SESSION_ENV]).toBeUndefined();
    expect(await harness.send(value)).toBe(true);
    expect(await harness.send(value)).toBe(true);
    await expect.poll(() => harness.fake.messages.length).toBe(1);

    expect(harness.fake.receipts).toEqual([{ customType: RECEIPT_TYPE, data: value }]);
    expect(harness.fake.exec).toHaveBeenCalledExactlyOnceWith(
      "pi-jq",
      [value.childSessionId, "--messages", "3", "--role", "assistant"],
      { signal: expect.any(AbortSignal), timeout: 5000 },
    );
    expect(harness.fake.messages[0]?.options).toEqual(expectedOptions);
    expect(harness.fake.messages[0]?.message).toMatchObject({
      customType: MESSAGE_TYPE,
      content: `Delegate ${value.taskSlug} (${value.childSessionId}) finished.\n\ntask complete\n\nContinue supervision.`,
      details: { ...value, output: "task complete" },
      display: true,
    });

    await harness.shutdown();
    expect(harness.env[PARENT_SESSION_ENV]).toBeUndefined();
    await expect(access(harness.socketPath)).rejects.toThrow();
  });

  it("uses a custom inspection command and supervision prompt", async () => {
    const harness = await startParentHarness({
      ipcOptions: {
        inspectionCommand: ["inspect-child", "--session", "{{childSessionId}}"],
        inspectionTimeoutMs: 1234,
        supervisionPrompt: "Review the child result.",
      },
    });
    const value = envelope();
    await harness.send(value);
    await expect.poll(() => harness.fake.messages.length).toBe(1);

    expect(harness.fake.exec).toHaveBeenCalledWith(
      "inspect-child",
      ["--session", value.childSessionId],
      { signal: expect.any(AbortSignal), timeout: 1234 },
    );
    expect(harness.fake.messages[0]?.message).toMatchObject({
      content: expect.stringContaining("Review the child result."),
    });
    await harness.shutdown();
  });

  it("ACKs the receipt before pi-jq finishes", async () => {
    let resolveExec: ((result: ExecResult) => void) | undefined;
    const harness = await startParentHarness({
      configureFake: (fake) =>
        fake.exec.mockImplementation(
          () =>
            new Promise<ExecResult>((resolve) => {
              resolveExec = resolve;
            }),
        ),
    });

    const value = envelope();
    expect(await harness.send(value, { ackTimeoutMs: 30, retryDelaysMs: [0] })).toBe(true);
    expect(harness.fake.receipts).toEqual([{ customType: RECEIPT_TYPE, data: value }]);
    expect(harness.fake.messages).toEqual([]);

    if (!resolveExec) {
      throw new Error("pi-jq was not started");
    }
    resolveExec({
      stdout: "child complete",
      stderr: "",
      code: 0,
      killed: false,
    });
    await expect.poll(() => harness.fake.messages.length).toBe(1);
    await harness.shutdown();
  });

  it("does not inject a notification after session shutdown", async () => {
    let resolveExec: ((result: ExecResult) => void) | undefined;
    const harness = await startParentHarness({
      configureFake: (fake) =>
        fake.exec.mockImplementation(
          () =>
            new Promise<ExecResult>((resolve) => {
              resolveExec = resolve;
            }),
        ),
    });
    await harness.send(envelope());

    const execOptions = harness.fake.exec.mock.calls[0]?.[2] as
      | { signal?: AbortSignal }
      | undefined;
    expect(execOptions?.signal?.aborted).toBe(false);
    await harness.shutdown();
    expect(execOptions?.signal?.aborted).toBe(true);

    if (!resolveExec) {
      throw new Error("pi-jq was not started");
    }
    resolveExec({
      stdout: "child complete",
      stderr: "",
      code: 0,
      killed: false,
    });
    await expect.poll(() => harness.fake.messages).toEqual([]);
  });

  it("replays a receipt that was not persisted as a model-visible message", async () => {
    const value = envelope();
    const harness = await startParentHarness({
      entries: [
        {
          type: "custom",
          customType: RECEIPT_TYPE,
          data: value,
        },
      ],
    });

    expect(harness.fake.receipts).toEqual([]);
    expect(harness.fake.exec).toHaveBeenCalledTimes(1);
    expect(harness.fake.messages).toHaveLength(1);
    expect(harness.fake.messages[0]?.message).toMatchObject({ details: value });
    await harness.shutdown();
  });

  it("restores delivered event deduplication across reloads", async () => {
    const value = envelope();
    const harness = await startParentHarness({
      entries: [
        {
          type: "custom",
          customType: RECEIPT_TYPE,
          data: value,
        },
        {
          type: "custom_message",
          customType: MESSAGE_TYPE,
          details: { ...value, output: "Already delivered" },
        },
      ],
    });

    expect(await harness.send(value)).toBe(true);
    expect(harness.fake.receipts).toEqual([]);
    expect(harness.fake.exec).not.toHaveBeenCalled();
    expect(harness.fake.messages).toEqual([]);
    await harness.shutdown();
  });

  testCases.each([
    ["a parent", {}, undefined],
    ["a child with a valid slug", { [CHILD_ENV]: "1", [TASK_SLUG_ENV]: "child-task" }, undefined],
    ["a child with no slug", { [CHILD_ENV]: "1" }, "PI_TASK_SLUG"],
    [
      "a child with an invalid slug",
      { [CHILD_ENV]: "1", [TASK_SLUG_ENV]: "bad slug" },
      "PI_TASK_SLUG",
    ],
  ])("validates %s at extension load", (_name, env, expectedError) => {
    const fake = createPi();

    if (expectedError) {
      expect(() => ipc(fake.api, { env })).toThrow(expectedError);
      return;
    }
    expect(() => ipc(fake.api, { env })).not.toThrow();
  });

  it("captures the inherited parent ID and task slug at load time", async () => {
    const runtimeDir = await createTempDir();
    const parentSessionId = randomUUID();
    const parentSocket = socketPathForSession(parentSessionId, runtimeDir);
    const received: DelegateSettledEnvelope[] = [];
    const parent = await startReceiver(parentSocket, (message) => received.push(message));
    const env: NodeJS.ProcessEnv = {
      [CHILD_ENV]: "1",
      [PARENT_SESSION_ENV]: parentSessionId,
      [TASK_SLUG_ENV]: "child-task",
    };
    const fake = createPi();
    const childSessionId = randomUUID();
    const leafId = randomUUID();
    const ctx = createContext({ sessionId: childSessionId, leafId });

    ipc(fake.api, {
      env,
      runtimeDir,
      ackTimeoutMs: 30,
      retryDelaysMs: [0],
    });
    const changedParentSessionId = randomUUID();
    env[PARENT_SESSION_ENV] = changedParentSessionId;
    await emit(fake, "session_start", ctx);
    expect(env[PARENT_SESSION_ENV]).toBe(changedParentSessionId);

    await emit(fake, "agent_settled", ctx);
    await emit(fake, "agent_settled", ctx);
    const nextLeafId = randomUUID();
    await emit(
      fake,
      "agent_settled",
      createContext({ sessionId: childSessionId, leafId: nextLeafId }),
    );

    expect(received).toHaveLength(3);
    expect(received.map((message) => message.childSessionId)).toEqual([
      childSessionId,
      childSessionId,
      childSessionId,
    ]);
    expect(received.map((message) => message.taskSlug)).toEqual([
      "child-task",
      "child-task",
      "child-task",
    ]);
    expect(received.map((message) => message.leafId)).toEqual([leafId, leafId, nextLeafId]);
    expect(eventKey(received[0]!)).toBe(eventKey(received[1]!));
    expect(eventKey(received[2]!)).not.toBe(eventKey(received[0]!));
    await emit(fake, "session_shutdown", ctx);
    expect(env[PARENT_SESSION_ENV]).toBe(changedParentSessionId);
    await parent.close();
  });

  it("preserves the launcher environment across an extension reload", async () => {
    const runtimeDir = await createTempDir();
    const parentSessionId = randomUUID();
    const parentSocket = socketPathForSession(parentSessionId, runtimeDir);
    const received: DelegateSettledEnvelope[] = [];
    const parent = await startReceiver(parentSocket, (message) => received.push(message));
    const env: NodeJS.ProcessEnv = {
      [CHILD_ENV]: "1",
      [PARENT_SESSION_ENV]: parentSessionId,
      [TASK_SLUG_ENV]: "reload-child",
    };
    const first = createPi();
    const firstCtx = createContext();

    ipc(first.api, { env, runtimeDir });
    await emit(first, "session_start", firstCtx);
    await emit(first, "session_shutdown", firstCtx);
    expect(env[PARENT_SESSION_ENV]).toBe(parentSessionId);

    const reloaded = createPi();
    const reloadedCtx = createContext();
    ipc(reloaded.api, {
      env,
      runtimeDir,
      ackTimeoutMs: 30,
      retryDelaysMs: [0],
    });
    await emit(reloaded, "session_start", reloadedCtx);
    await emit(reloaded, "agent_settled", reloadedCtx);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      childSessionId: reloadedCtx.sessionManager.getSessionId(),
      taskSlug: "reload-child",
    });
    await emit(reloaded, "session_shutdown", reloadedCtx);
    await parent.close();
  });

  it("does not notify when PI_CHILD was absent at load time", async () => {
    const harness = await startParentHarness();

    await emit(harness.fake, "agent_settled", harness.ctx);
    expect(harness.fake.receipts).toEqual([]);
    expect(harness.fake.messages).toEqual([]);
    await harness.shutdown();
  });
});
