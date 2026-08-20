import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  SessionCompactEvent,
  SessionInfoChangedEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

type AssistantMessageEvent = MessageUpdateEvent["assistantMessageEvent"];
type StopReason = Extract<AssistantMessageEvent, { type: "done" | "error" }>["reason"];
type ModelIdentity = { provider: string; id: string; name: string };
type LiveModelSelectEvent = {
  type: "model_select";
  source: "set" | "cycle" | "restore";
  model: ModelIdentity;
  previousModel?: ModelIdentity;
};
type LiveThinkingLevelSelectEvent = {
  type: "thinking_level_select";
  level: string;
  previousLevel: string;
};

export type CompactAssistantMessageEvent =
  | { type: "start" }
  | {
      type:
        | "text_start"
        | "text_end"
        | "thinking_start"
        | "thinking_end"
        | "toolcall_start"
        | "toolcall_end";
      contentIndex: number;
    }
  | {
      type: "text_delta" | "thinking_delta" | "toolcall_delta";
      contentIndex: number;
      delta: string;
    }
  | { type: "done"; reason: StopReason }
  | { type: "error"; reason: StopReason; errorMessage?: string };

export type LiveEventPayload =
  | (SessionStartEvent & { cwd: string; sessionFile?: string; pid: number })
  | SessionShutdownEvent
  | SessionInfoChangedEvent
  | SessionCompactEvent
  | SessionTreeEvent
  | AgentStartEvent
  | { type: AgentEndEvent["type"] }
  | AgentSettledEvent
  | TurnStartEvent
  | { type: TurnEndEvent["type"]; turnIndex: number }
  | {
      type: MessageStartEvent["type"];
      messageId: string;
      messageSequence: number;
      message: MessageStartEvent["message"];
    }
  | {
      type: MessageUpdateEvent["type"];
      messageId: string;
      messageSequence: number;
      assistantMessageEvent: CompactAssistantMessageEvent;
    }
  | {
      type: MessageEndEvent["type"];
      messageId: string;
      messageSequence: number;
      message: MessageEndEvent["message"];
    }
  | ToolExecutionStartEvent
  | ToolExecutionEndEvent
  | LiveModelSelectEvent
  | LiveThinkingLevelSelectEvent;

export type LiveEventRecord = {
  version: 1;
  sessionId: string;
  processInstanceId: string;
  streamId: string;
  sequence: number;
  timestamp: number;
  event: LiveEventPayload;
};

export type LiveEventWriter = {
  filePath: string;
  streamId: string;
  append: (event: LiveEventPayload) => void;
  close: (event: SessionShutdownEvent) => Promise<void>;
};

type LiveEventWriterState = {
  filePath: string;
  sessionDir: string;
  sessionId: string;
  processInstanceId: string;
  streamId: string;
  sequence: number;
  accepting: boolean;
  directoryReady: boolean;
  failed: boolean;
  writeChain: Promise<void>;
  onError?: (error: unknown) => void;
};

type LiveEventCapture = {
  start: (event: SessionStartEvent, ctx: ExtensionContext) => void;
  stop: (event: SessionShutdownEvent) => Promise<void>;
};

type LiveEventCaptureState = {
  writer?: LiveEventWriter;
  messageSequence: number;
  activeMessage?: { id: string; sequence: number; role: string };
};

const PROCESS_INSTANCE_KEY = Symbol.for("pi-ipc.live-events.process-instance-id");
const processGlobals = globalThis as typeof globalThis & { [PROCESS_INSTANCE_KEY]?: string };
const existingProcessInstanceId = processGlobals[PROCESS_INSTANCE_KEY];
export const PROCESS_INSTANCE_ID = existingProcessInstanceId ?? `${process.pid}-${randomUUID()}`;
processGlobals[PROCESS_INSTANCE_KEY] = PROCESS_INSTANCE_ID;

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

const requirePathSegment = (value: string, label: string): string => {
  if (!SAFE_PATH_SEGMENT.test(value)) throw new Error(`Invalid ${label} for live event path`);
  return value;
};

export const liveEventSessionDir = (rootDir: string, sessionId: string): string =>
  join(resolve(rootDir), requirePathSegment(sessionId, "session ID"));

export const liveEventStreamPath = (rootDir: string, sessionId: string, streamId: string): string =>
  join(
    liveEventSessionDir(rootDir, sessionId),
    `${requirePathSegment(streamId, "stream ID")}.jsonl`,
  );

const isSameOrWithin = (parent: string, candidate: string): boolean => {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`));
};

const assertSeparateFromSessionFile = (rootDir: string, sessionFile: string | undefined): void => {
  if (!sessionFile) return;
  const sessionDir = dirname(sessionFile);
  if (isSameOrWithin(rootDir, sessionDir) || isSameOrWithin(sessionDir, rootDir)) {
    throw new Error("Live events directory must be outside the Pi session directory tree");
  }
};

const reportError = (onError: ((error: unknown) => void) | undefined, error: unknown): void => {
  try {
    onError?.(error);
  } catch {}
};

const reportWriterError = (state: LiveEventWriterState, error: unknown): void => {
  state.failed = true;
  reportError(state.onError, error);
};

const appendLiveEvent = (state: LiveEventWriterState, event: LiveEventPayload): void => {
  if (!state.accepting || state.failed) return;

  const record: LiveEventRecord = {
    version: 1,
    sessionId: state.sessionId,
    processInstanceId: state.processInstanceId,
    streamId: state.streamId,
    sequence: state.sequence,
    timestamp: Date.now(),
    event,
  };
  state.sequence += 1;

  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch (error) {
    reportWriterError(state, error);
    return;
  }

  state.writeChain = state.writeChain
    .then(async () => {
      if (!state.directoryReady) {
        await mkdir(state.sessionDir, { recursive: true, mode: 0o700 });
        state.directoryReady = true;
      }
      await appendFile(state.filePath, line, { encoding: "utf8", mode: 0o600 });
    })
    .catch((error: unknown) => reportWriterError(state, error));
};

const closeLiveEventWriter = async (
  state: LiveEventWriterState,
  event: SessionShutdownEvent,
): Promise<void> => {
  if (!state.accepting) {
    await state.writeChain;
    return;
  }

  appendLiveEvent(state, event);
  state.accepting = false;
  await state.writeChain;
};

export const createLiveEventWriter = ({
  rootDir,
  sessionId,
  processInstanceId = PROCESS_INSTANCE_ID,
  streamId = randomUUID(),
  onError,
}: {
  rootDir: string;
  sessionId: string;
  processInstanceId?: string;
  streamId?: string;
  onError?: (error: unknown) => void;
}): LiveEventWriter => {
  const state: LiveEventWriterState = {
    filePath: liveEventStreamPath(rootDir, sessionId, streamId),
    sessionDir: liveEventSessionDir(rootDir, sessionId),
    sessionId,
    processInstanceId,
    streamId,
    sequence: 1,
    accepting: true,
    directoryReady: false,
    failed: false,
    writeChain: Promise.resolve(),
    onError,
  };

  return {
    filePath: state.filePath,
    streamId: state.streamId,
    append: (event) => appendLiveEvent(state, event),
    close: (event) => closeLiveEventWriter(state, event),
  };
};

export const compactAssistantMessageEvent = (
  event: AssistantMessageEvent,
): CompactAssistantMessageEvent => {
  if (event.type === "start") return { type: event.type };
  if (event.type === "done") return { type: event.type, reason: event.reason };
  if (event.type === "error") {
    const errorMessage = event.error.errorMessage;
    return { type: event.type, reason: event.reason, ...(errorMessage ? { errorMessage } : {}) };
  }
  if (
    event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "toolcall_delta"
  ) {
    return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
  }
  return { type: event.type, contentIndex: event.contentIndex };
};

const modelIdentity = (model: ModelIdentity): ModelIdentity => ({
  provider: model.provider,
  id: model.id,
  name: model.name,
});

const messageRole = (event: MessageStartEvent | MessageEndEvent): string => event.message.role;

export const registerLiveEventCapture = (
  pi: ExtensionAPI,
  options: { rootDir: string | null; onError?: (error: unknown) => void },
): LiveEventCapture => {
  const state: LiveEventCaptureState = { messageSequence: 0 };
  const append = (event: LiveEventPayload) => state.writer?.append(event);

  pi.on("session_info_changed", (event) => append(event));
  pi.on("session_compact", (event) => append(event));
  pi.on("session_tree", (event) => append(event));
  pi.on("agent_start", (event) => append(event));
  pi.on("agent_end", (event) => append({ type: event.type }));
  pi.on("agent_settled", (event) => append(event));
  pi.on("turn_start", (event) => append(event));
  pi.on("turn_end", (event) => append({ type: event.type, turnIndex: event.turnIndex }));
  pi.on("message_start", (event) => {
    state.messageSequence += 1;
    const activeMessage = {
      id: `${state.writer?.streamId ?? "inactive"}:${state.messageSequence}`,
      sequence: state.messageSequence,
      role: messageRole(event),
    };
    state.activeMessage = activeMessage;
    append({
      type: event.type,
      messageId: activeMessage.id,
      messageSequence: activeMessage.sequence,
      message: event.message,
    });
  });
  pi.on("message_update", (event) => {
    const activeMessage = state.activeMessage;
    if (!activeMessage || activeMessage.role !== "assistant") return;
    append({
      type: event.type,
      messageId: activeMessage.id,
      messageSequence: activeMessage.sequence,
      assistantMessageEvent: compactAssistantMessageEvent(event.assistantMessageEvent),
    });
  });
  pi.on("message_end", (event) => {
    const activeMessage = state.activeMessage;
    if (!activeMessage) state.messageSequence += 1;
    const identity = activeMessage ?? {
      id: `${state.writer?.streamId ?? "inactive"}:${state.messageSequence}`,
      sequence: state.messageSequence,
      role: messageRole(event),
    };
    append({
      type: event.type,
      messageId: identity.id,
      messageSequence: identity.sequence,
      message: event.message,
    });
    state.activeMessage = undefined;
  });
  pi.on("tool_execution_start", (event) => append(event));
  pi.on("tool_execution_end", (event) => append(event));
  pi.on("model_select", (event) =>
    append({
      type: event.type,
      source: event.source,
      model: modelIdentity(event.model),
      ...(event.previousModel ? { previousModel: modelIdentity(event.previousModel) } : {}),
    }),
  );
  pi.on("thinking_level_select", (event) => append(event));

  return {
    start: (event, ctx) => {
      state.messageSequence = 0;
      state.activeMessage = undefined;
      if (!options.rootDir) return;
      try {
        const sessionFile = ctx.sessionManager.getSessionFile();
        assertSeparateFromSessionFile(options.rootDir, sessionFile);
        state.writer = createLiveEventWriter({
          rootDir: options.rootDir,
          sessionId: ctx.sessionManager.getSessionId(),
          onError: options.onError,
        });
        append({
          ...event,
          cwd: ctx.cwd,
          sessionFile,
          pid: process.pid,
        });
      } catch (error) {
        state.writer = undefined;
        reportError(options.onError, error);
      }
    },
    stop: async (event) => {
      const writer = state.writer;
      state.writer = undefined;
      state.activeMessage = undefined;
      await writer?.close(event);
    },
  };
};
