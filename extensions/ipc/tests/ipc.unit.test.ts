import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, test as testCases, vi } from "vitest";

import {
  eventKey,
  ipc,
  MESSAGE_TYPE,
  PARENT_SESSION_ENV,
  parseEnvelope,
  RECEIPT_TYPE,
  sendEnvelope,
  socketPathForSession,
  startReceiver,
  TASK_SLUG_ENV,
  truncatePiJqOutput,
  type DelegateSettledEnvelope,
  type IpcOptions,
} from "../src/extension";
import { DEFAULT_IPC_CONFIG, IpcConfigSchema } from "../src/config";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type SentMessage = { message: unknown; options: unknown };
type FakePi = {
  api: ExtensionAPI;
  handlers: Map<string, Handler>;
  receipts: { customType: string; data: unknown }[];
  messages: SentMessage[];
  renderers: Map<string, MessageRenderer<unknown>>;
  exec: ReturnType<typeof vi.fn>;
};

const tempDirs: string[] = [];

const createTempDir = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ipc-test-"));
  tempDirs.push(directory);
  return directory;
};

const envelope = (overrides: Partial<DelegateSettledEnvelope> = {}): DelegateSettledEnvelope => ({
  childSessionId: randomUUID(),
  taskSlug: "ipc-task",
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
  const handlers = new Map<string, Handler>();
  const receipts: { customType: string; data: unknown }[] = [];
  const messages: SentMessage[] = [];
  const renderers = new Map<string, MessageRenderer<unknown>>();
  const exec = vi.fn(async () => execResult);
  const api = {
    exec,
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: (customType: string, data: unknown) => receipts.push({ customType, data }),
    registerMessageRenderer: (customType: string, renderer: MessageRenderer<unknown>) =>
      renderers.set(customType, renderer),
    sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
  } as unknown as ExtensionAPI;

  return { api, handlers, receipts, messages, renderers, exec };
};

const createContext = ({
  idle = true,
  entries = [],
  sessionId = randomUUID(),
  leafId = randomUUID(),
}: {
  idle?: boolean;
  entries?: unknown[];
  sessionId?: string;
  leafId?: string;
} = {}): ExtensionContext =>
  ({
    cwd: "/tmp/project",
    isIdle: () => idle,
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => sessionId,
      getLeafId: () => leafId,
    },
  }) as unknown as ExtensionContext;

const emit = async (fake: FakePi, event: string, ctx: ExtensionContext): Promise<void> => {
  await fake.handlers.get(event)?.({}, ctx);
};

type ParentHarnessOptions = {
  idle?: boolean;
  entries?: unknown[];
  sessionId?: string;
  leafId?: string;
  env?: NodeJS.ProcessEnv;
  execResult?: ExecResult;
  configureFake?: (fake: FakePi) => void;
  ipcOptions?: Omit<IpcOptions, "env" | "state" | "runtimeDir">;
};

const startParentHarness = async ({
  idle,
  entries,
  sessionId = randomUUID(),
  leafId,
  env = {},
  execResult,
  configureFake,
  ipcOptions,
}: ParentHarnessOptions = {}) => {
  const runtimeDir = await createTempDir();
  const fake = createPi(execResult);
  configureFake?.(fake);
  const ctx = createContext({ idle, entries, sessionId, leafId });
  const socketPath = socketPathForSession(sessionId, runtimeDir);
  ipc(fake.api, { env, runtimeDir, ...ipcOptions });
  await emit(fake, "session_start", ctx);

  return {
    runtimeDir,
    sessionId,
    socketPath,
    env,
    fake,
    ctx,
    send: (value: DelegateSettledEnvelope, options: Parameters<typeof sendEnvelope>[2] = {}) =>
      sendEnvelope(socketPath, value, options),
    shutdown: () => emit(fake, "session_shutdown", ctx),
  };
};

const renderFriendlyNotification = (taskSlug: string): string[] => {
  const fake = createPi();
  const value = envelope({ taskSlug });
  ipc(fake.api, { env: {} });
  const renderer = fake.renderers.get(MESSAGE_TYPE);
  if (!renderer) throw new Error("IPC message renderer was not registered");

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

describe("ipc configuration", () => {
  it("uses the documented defaults", () => {
    expect(IpcConfigSchema.parse({})).toEqual(DEFAULT_IPC_CONFIG);
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

    expect(await harness.send(envelope(), { ackTimeoutMs: 30, retryDelaysMs: [0] })).toBe(true);
    expect(harness.fake.messages).toEqual([]);

    if (!resolveExec) throw new Error("pi-jq was not started");
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

    if (!resolveExec) throw new Error("pi-jq was not started");
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
      entries: [{ type: "custom", customType: RECEIPT_TYPE, data: value }],
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
        { type: "custom", customType: RECEIPT_TYPE, data: value },
        { type: "custom_message", customType: MESSAGE_TYPE, details: value },
      ],
    });

    expect(await harness.send(value)).toBe(true);
    expect(harness.fake.receipts).toEqual([]);
    expect(harness.fake.exec).not.toHaveBeenCalled();
    expect(harness.fake.messages).toEqual([]);
    await harness.shutdown();
  });

  testCases.each([
    ["a non-delegated parent", {}, undefined],
    [
      "a delegated child with a valid slug",
      { PI_DELEGATE: "1", [TASK_SLUG_ENV]: "child-task" },
      undefined,
    ],
    ["a delegated child with no slug", { PI_DELEGATE: "1" }, "PI_DELEGATE_TASK_SLUG"],
    [
      "a delegated child with an invalid slug",
      { PI_DELEGATE: "1", [TASK_SLUG_ENV]: "bad slug" },
      "PI_DELEGATE_TASK_SLUG",
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
      PI_DELEGATE: "1",
      [PARENT_SESSION_ENV]: parentSessionId,
      [TASK_SLUG_ENV]: "child-task",
    };
    const fake = createPi();
    const childSessionId = randomUUID();
    const leafId = randomUUID();
    const ctx = createContext({ sessionId: childSessionId, leafId });

    ipc(fake.api, { env, runtimeDir, ackTimeoutMs: 30, retryDelaysMs: [0] });
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
      PI_DELEGATE: "1",
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

  it("does not notify when PI_DELEGATE was absent at load time", async () => {
    const harness = await startParentHarness();

    await emit(harness.fake, "agent_settled", harness.ctx);
    expect(harness.fake.receipts).toEqual([]);
    expect(harness.fake.messages).toEqual([]);
    await harness.shutdown();
  });
});
