import { lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

export const CHILD_ENV = "PI_CHILD";
export const PARENT_SESSION_ENV = "PI_PARENT_SESSION_ID";
export const TASK_SLUG_ENV = "PI_TASK_SLUG";

const MAX_MESSAGE_BYTES = 4096;
const MAX_USER_MESSAGE_BYTES = 3072;
const ACK = "ACK";
const MAX_RESPONSE_BYTES = 512;
const SOCKET_PATH_LIMIT = 100;
const ACK_TIMEOUT_MS = 400;
const PROBE_TIMEOUT_MS = 150;
const INBOUND_TIMEOUT_MS = 1000;
const MAX_CONNECTIONS = 32;
const RETRY_DELAYS_MS = [0, 80, 160] as const;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const TASK_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,11}[a-z0-9])?$/;
export const DEFAULT_RUNTIME_DIR = `/tmp/pi-ipc-${process.getuid?.() ?? "u"}`;

export type DelegateSettledEnvelope = {
  childSessionId: string;
  taskSlug: string;
  leafId: string;
  cwd: string;
  timestamp: number;
};

export type UserMessageRequest = {
  version: 1;
  requestId: string;
  type: "user_message";
  message: string;
  deliverAs: "steer" | "followUp";
  expandPromptTemplates: boolean;
};

export type UserMessageResponse =
  | {
      version: 1;
      requestId: string;
      ok: true;
      delivery: "immediate" | "steer" | "followUp";
    }
  | {
      version: 1;
      requestId: string;
      ok: false;
      error: "shutting_down" | "unavailable";
    };

export type UserMessageInput = Omit<
  UserMessageRequest,
  "version" | "type" | "expandPromptTemplates"
> & {
  expandPromptTemplates?: boolean;
};

export type AbortRequest = {
  version: 1;
  requestId: string;
  type: "abort";
};

export type AbortResponse =
  | { version: 1; requestId: string; ok: true }
  | {
      version: 1;
      requestId: string;
      ok: false;
      error: "shutting_down" | "unavailable";
    };

export type AbortInput = Omit<AbortRequest, "version" | "type">;

type PiControlError = "no_key" | "not_found" | "shutting_down" | "unavailable";
type PiControlResponse =
  | { version: 1; requestId: string; ok: true }
  | { version: 1; requestId: string; ok: false; error: PiControlError };

export type SetModelRequest = {
  version: 1;
  requestId: string;
  type: "set_model";
  provider: string;
  id: string;
};
export type SetModelInput = Omit<SetModelRequest, "version" | "type">;
export type SetModelResponse = PiControlResponse;

export type SetThinkingLevelRequest = {
  version: 1;
  requestId: string;
  type: "set_thinking_level";
  level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};
export type SetThinkingLevelInput = Omit<SetThinkingLevelRequest, "version" | "type">;
export type SetThinkingLevelResponse = PiControlResponse;

export type Receiver = { close: () => Promise<void> };
export type ReceiverOptions = {
  onAbort?: (request: AbortRequest) => AbortResponse;
  onSetModel?: (request: SetModelRequest) => Promise<SetModelResponse>;
  onSetThinkingLevel?: (request: SetThinkingLevelRequest) => SetThinkingLevelResponse;
  onUserMessage?: (request: UserMessageRequest) => UserMessageResponse;
};
export type SenderOptions = {
  runtimeDir?: string;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
};

export type ProbeOptions = Pick<SenderOptions, "runtimeDir" | "timeoutMs">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === "string" && ID_PATTERN.test(value);

export const socketPathForSession = (
  sessionId: string,
  runtimeDir = DEFAULT_RUNTIME_DIR,
): string => {
  if (!isId(sessionId)) {
    throw new Error("Invalid Pi session ID for delegate notification socket");
  }
  const socketPath = join(runtimeDir, `${sessionId}.sock`);
  if (Buffer.byteLength(socketPath) > SOCKET_PATH_LIMIT) {
    throw new Error(`Delegate notification socket path exceeds ${SOCKET_PATH_LIMIT} bytes`);
  }
  return socketPath;
};

export const parseEnvelope = (input: string): DelegateSettledEnvelope | undefined => {
  if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(input);
    if (!isRecord(value)) {
      return undefined;
    }
    if (Object.keys(value).length !== 5 || !isId(value.childSessionId) || !isId(value.leafId)) {
      return undefined;
    }
    if (typeof value.taskSlug !== "string" || !TASK_SLUG_PATTERN.test(value.taskSlug)) {
      return undefined;
    }
    if (typeof value.cwd !== "string" || value.cwd.length < 1 || value.cwd.length > 2048) {
      return undefined;
    }
    if (!Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0) {
      return undefined;
    }
    return value as DelegateSettledEnvelope;
  } catch {
    return undefined;
  }
};

export const parseAbortRequest = (input: string): AbortRequest | undefined => {
  if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(input);
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 3 ||
      value.version !== 1 ||
      value.type !== "abort" ||
      !isId(value.requestId)
    ) {
      return undefined;
    }
    return value as AbortRequest;
  } catch {
    return undefined;
  }
};

export const parseSetModelRequest = (input: string): SetModelRequest | undefined => {
  try {
    const value: unknown = JSON.parse(input);
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 5 ||
      value.version !== 1 ||
      value.type !== "set_model" ||
      !isId(value.requestId) ||
      typeof value.provider !== "string" ||
      !value.provider ||
      typeof value.id !== "string" ||
      !value.id
    ) {
      return undefined;
    }
    return value as SetModelRequest;
  } catch {
    return undefined;
  }
};

export const parseSetThinkingLevelRequest = (
  input: string,
): SetThinkingLevelRequest | undefined => {
  try {
    const value: unknown = JSON.parse(input);
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 4 ||
      value.version !== 1 ||
      value.type !== "set_thinking_level" ||
      !isId(value.requestId) ||
      typeof value.level !== "string" ||
      !levels.includes(value.level)
    ) {
      return undefined;
    }
    return value as SetThinkingLevelRequest;
  } catch {
    return undefined;
  }
};

export const parseUserMessageRequest = (input: string): UserMessageRequest | undefined => {
  if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(input);
    if (!isRecord(value)) {
      return undefined;
    }
    const keys = Object.keys(value);
    const allowedKeys = new Set([
      "version",
      "requestId",
      "type",
      "message",
      "deliverAs",
      "expandPromptTemplates",
    ]);
    if (keys.length < 5 || keys.length > 6 || keys.some((key) => !allowedKeys.has(key))) {
      return undefined;
    }
    if (value.version !== 1 || value.type !== "user_message" || !isId(value.requestId)) {
      return undefined;
    }
    if (typeof value.message !== "string" || !value.message.trim()) {
      return undefined;
    }
    if (Buffer.byteLength(value.message) > MAX_USER_MESSAGE_BYTES) {
      return undefined;
    }
    if (value.deliverAs !== "steer" && value.deliverAs !== "followUp") {
      return undefined;
    }
    if (
      value.expandPromptTemplates !== undefined &&
      typeof value.expandPromptTemplates !== "boolean"
    ) {
      return undefined;
    }
    return {
      ...value,
      expandPromptTemplates: value.expandPromptTemplates ?? true,
    } as UserMessageRequest;
  } catch {
    return undefined;
  }
};

const parseUserMessageResponse = (
  input: string,
  requestId: string,
): UserMessageResponse | undefined => {
  try {
    const value: unknown = JSON.parse(input);
    if (!isRecord(value) || value.version !== 1 || value.requestId !== requestId) {
      return undefined;
    }
    const keys = Object.keys(value);
    const successKeys = ["version", "requestId", "ok", "delivery"];
    if (
      value.ok === true &&
      keys.length === successKeys.length &&
      keys.every((key) => successKeys.includes(key)) &&
      (value.delivery === "immediate" ||
        value.delivery === "steer" ||
        value.delivery === "followUp")
    ) {
      return value as UserMessageResponse;
    }
    const errorKeys = ["version", "requestId", "ok", "error"];
    if (
      value.ok === false &&
      keys.length === errorKeys.length &&
      keys.every((key) => errorKeys.includes(key)) &&
      (value.error === "shutting_down" || value.error === "unavailable")
    ) {
      return value as UserMessageResponse;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

export const eventKey = ({ childSessionId, leafId }: DelegateSettledEnvelope): string =>
  `${childSessionId}\0${leafId}`;

const responsePayload = (
  response: UserMessageResponse | AbortResponse | PiControlResponse,
): string => JSON.stringify(response);

const parseControlResponse = (input: string, requestId: string): PiControlResponse | undefined => {
  try {
    const value: unknown = JSON.parse(input);
    if (!isRecord(value) || value.version !== 1 || value.requestId !== requestId) {
      return undefined;
    }
    if (value.ok === true && Object.keys(value).length === 3) {
      return value as PiControlResponse;
    }
    if (
      value.ok === false &&
      Object.keys(value).length === 4 &&
      (value.error === "no_key" ||
        value.error === "not_found" ||
        value.error === "shutting_down" ||
        value.error === "unavailable")
    ) {
      return value as PiControlResponse;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

const parseAbortResponse = (input: string, requestId: string): AbortResponse | undefined => {
  try {
    const value: unknown = JSON.parse(input);
    if (!isRecord(value) || value.version !== 1 || value.requestId !== requestId) {
      return undefined;
    }
    if (value.ok === true && Object.keys(value).length === 3) {
      return value as AbortResponse;
    }
    if (
      value.ok === false &&
      Object.keys(value).length === 4 &&
      (value.error === "shutting_down" || value.error === "unavailable")
    ) {
      return value as AbortResponse;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

export const startReceiver = async (
  socketPath: string,
  onEnvelope: (envelope: DelegateSettledEnvelope) => void,
  options: ReceiverOptions | number = {},
  timeoutMs = INBOUND_TIMEOUT_MS,
): Promise<Receiver> => {
  const receiverOptions = typeof options === "number" ? {} : options;
  const resolvedTimeoutMs = typeof options === "number" ? options : timeoutMs;
  await removeStaleSocket(socketPath);
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(resolvedTimeoutMs, () => socket.destroy());
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) {
        socket.destroy();
      }
    });
    socket.on("end", () => {
      const envelope = parseEnvelope(input);
      if (envelope) {
        try {
          onEnvelope(envelope);
          socket.end(ACK);
        } catch {
          socket.destroy();
        }
        return;
      }
      const setModelRequest = parseSetModelRequest(input);
      if (setModelRequest && receiverOptions.onSetModel) {
        void receiverOptions
          .onSetModel(setModelRequest)
          .then((response) => socket.end(responsePayload(response)))
          .catch(() => socket.destroy());
        return;
      }
      const setThinkingLevelRequest = parseSetThinkingLevelRequest(input);
      if (setThinkingLevelRequest && receiverOptions.onSetThinkingLevel) {
        try {
          socket.end(responsePayload(receiverOptions.onSetThinkingLevel(setThinkingLevelRequest)));
        } catch {
          socket.destroy();
        }
        return;
      }
      const abortRequest = parseAbortRequest(input);
      if (abortRequest && receiverOptions.onAbort) {
        try {
          socket.end(responsePayload(receiverOptions.onAbort(abortRequest)));
        } catch {
          socket.destroy();
        }
        return;
      }
      const userMessageRequest = parseUserMessageRequest(input);
      if (!userMessageRequest || !receiverOptions.onUserMessage) {
        socket.destroy();
        return;
      }
      try {
        socket.end(responsePayload(receiverOptions.onUserMessage(userMessageRequest)));
      } catch {
        socket.destroy();
      }
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  server.maxConnections = MAX_CONNECTIONS;
  await listen(server, socketPath);
  let closed = false;
  return {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      sockets.forEach((socket) => socket.destroy());
      await closeServer(server);
      await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    },
  };
};

const probeSocket = (socketPath: string): Promise<"active" | "stale"> =>
  new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const finish = (result: "active" | "stale") => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(100, () => finish("active"));
    socket.on("connect", () => finish("active"));
    socket.on("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "stale" : "active"),
    );
  });

const removeStaleSocket = async (socketPath: string): Promise<void> => {
  const stats = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (!stats) {
    return;
  }
  if (!stats.isSocket()) {
    throw new Error(`Delegate notification path is not a socket: ${socketPath}`);
  }
  if ((await probeSocket(socketPath)) === "active") {
    throw new Error(`Delegate notification socket is already active: ${socketPath}`);
  }
  await unlink(socketPath);
};

const listen = (server: Server, socketPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const sendAttempt = (
  socketPath: string,
  payload: string,
  timeoutMs: number,
): Promise<string | undefined> =>
  new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let response = "";
    let finished = false;
    const finish = (result: string | undefined) => {
      if (finished) {
        return;
      }
      finished = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish(undefined));
    socket.on("connect", () => socket.end(payload));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
        finish(undefined);
      }
    });
    socket.on("end", () => finish(response));
    socket.on("error", () => finish(undefined));
  });

export const probePiSession = async (
  sessionId: string,
  options: ProbeOptions = {},
): Promise<boolean> => {
  let socketPath: string;
  try {
    socketPath = socketPathForSession(sessionId, options.runtimeDir);
  } catch {
    return false;
  }
  return (await sendAttempt(socketPath, "", options.timeoutMs ?? PROBE_TIMEOUT_MS)) !== undefined;
};

export const sendEnvelope = async (
  socketPath: string,
  envelope: DelegateSettledEnvelope,
  options: { ackTimeoutMs?: number; retryDelaysMs?: readonly number[] } = {},
): Promise<boolean> => {
  const payload = JSON.stringify(envelope);
  if (!parseEnvelope(payload)) {
    return false;
  }
  for (const delay of options.retryDelaysMs ?? RETRY_DELAYS_MS) {
    if (delay > 0) {
      await wait(delay);
    }
    if ((await sendAttempt(socketPath, payload, options.ackTimeoutMs ?? ACK_TIMEOUT_MS)) === ACK) {
      return true;
    }
  }
  return false;
};

export const sendUserMessage = async (
  sessionId: string,
  request: UserMessageInput,
  options: SenderOptions = {},
): Promise<UserMessageResponse | undefined> => {
  const payload = JSON.stringify({
    version: 1,
    type: "user_message",
    ...request,
  });
  const parsed = parseUserMessageRequest(payload);
  if (!parsed) {
    return undefined;
  }

  const socketPath = socketPathForSession(sessionId, options.runtimeDir);
  for (const delay of options.retryDelaysMs ?? RETRY_DELAYS_MS) {
    if (delay > 0) {
      await wait(delay);
    }
    const response = await sendAttempt(socketPath, payload, options.timeoutMs ?? ACK_TIMEOUT_MS);
    const parsedResponse = response
      ? parseUserMessageResponse(response, parsed.requestId)
      : undefined;
    if (parsedResponse) {
      return parsedResponse;
    }
  }
  return undefined;
};

export const sendAbort = async (
  sessionId: string,
  request: AbortInput,
  options: SenderOptions = {},
): Promise<AbortResponse | undefined> => {
  const payload = JSON.stringify({ version: 1, type: "abort", ...request });
  const parsed = parseAbortRequest(payload);
  if (!parsed) {
    return undefined;
  }

  const socketPath = socketPathForSession(sessionId, options.runtimeDir);
  for (const delay of options.retryDelaysMs ?? RETRY_DELAYS_MS) {
    if (delay > 0) {
      await wait(delay);
    }
    const response = await sendAttempt(socketPath, payload, options.timeoutMs ?? ACK_TIMEOUT_MS);
    const parsedResponse = response ? parseAbortResponse(response, parsed.requestId) : undefined;
    if (parsedResponse) {
      return parsedResponse;
    }
  }
  return undefined;
};

const sendControl = async <Input extends { requestId: string }>(
  sessionId: string,
  payload: Record<string, unknown>,
  request: Input,
  options: SenderOptions,
): Promise<PiControlResponse | undefined> => {
  const socketPath = socketPathForSession(sessionId, options.runtimeDir);
  for (const delay of options.retryDelaysMs ?? RETRY_DELAYS_MS) {
    if (delay > 0) {
      await wait(delay);
    }
    const response = await sendAttempt(
      socketPath,
      JSON.stringify(payload),
      options.timeoutMs ?? ACK_TIMEOUT_MS,
    );
    const parsed = response ? parseControlResponse(response, request.requestId) : undefined;
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
};

export const sendSetModel = (
  sessionId: string,
  request: SetModelInput,
  options: SenderOptions = {},
): Promise<SetModelResponse | undefined> =>
  sendControl(sessionId, { version: 1, type: "set_model", ...request }, request, options);

export const sendSetThinkingLevel = (
  sessionId: string,
  request: SetThinkingLevelInput,
  options: SenderOptions = {},
): Promise<SetThinkingLevelResponse | undefined> =>
  sendControl(sessionId, { version: 1, type: "set_thinking_level", ...request }, request, options);

export const ensureRuntimeDir = async (runtimeDir: string): Promise<void> => {
  await mkdir(runtimeDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") {
      throw error;
    }
  });
  const stats = await lstat(runtimeDir);
  const expectedUid = process.getuid?.();
  if (!stats.isDirectory() || (expectedUid !== undefined && stats.uid !== expectedUid)) {
    throw new Error(`Delegate notification runtime directory is not private: ${runtimeDir}`);
  }
  if ((stats.mode & 0o777) !== 0o700) {
    throw new Error(`Delegate notification runtime directory must have mode 0700: ${runtimeDir}`);
  }
};
