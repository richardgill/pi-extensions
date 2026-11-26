import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  createPiSessionStatusWriter,
  type PiSessionStatusUpdate,
  type PiSessionStatusWriter,
} from "./session-status";

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

export type LiveEventEnvelope<Event> = {
  version: 1;
  sessionId: string;
  processInstanceId: string;
  streamId: string;
  sequence: number;
  timestamp: number;
  event: Event;
};

export type LiveEventRecord = LiveEventEnvelope<LiveEventPayload>;
export type LiveEventWireRecord = LiveEventEnvelope<Record<string, unknown> & { type: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseLiveEventRecord = (
  value: unknown,
  sessionId?: string,
): LiveEventWireRecord | undefined => {
  if (!isRecord(value) || value.version !== 1) {
    return undefined;
  }
  if (sessionId !== undefined && value.sessionId !== sessionId) {
    return undefined;
  }
  if (
    typeof value.sessionId !== "string" ||
    typeof value.processInstanceId !== "string" ||
    typeof value.streamId !== "string" ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    typeof value.timestamp !== "number" ||
    !isRecord(value.event) ||
    typeof value.event.type !== "string"
  ) {
    return undefined;
  }
  return value as LiveEventWireRecord;
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
  start: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
  stop: (event: SessionShutdownEvent) => Promise<void>;
};

type LiveEventCaptureState = {
  writer?: LiveEventWriter;
  statusWriter?: PiSessionStatusWriter;
  messageSequence: number;
  activeMessage?: { id: string; sequence: number; role: string };
};

const PROCESS_INSTANCE_KEY = Symbol.for("pi-ipc.live-events.process-instance-id");
const processGlobals = globalThis as typeof globalThis & {
  [PROCESS_INSTANCE_KEY]?: string;
};
const existingProcessInstanceId = processGlobals[PROCESS_INSTANCE_KEY];
export const PROCESS_INSTANCE_ID = existingProcessInstanceId ?? `${process.pid}-${randomUUID()}`;
processGlobals[PROCESS_INSTANCE_KEY] = PROCESS_INSTANCE_ID;

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

const requirePathSegment = (value: string, label: string): string => {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label} for live event path`);
  }
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
  if (!sessionFile) {
    return;
  }
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
  if (!state.accepting || state.failed) {
    return;
  }

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
  if (event.type === "start") {
    return { type: event.type };
  }
  if (event.type === "done") {
    return { type: event.type, reason: event.reason };
  }
  if (event.type === "error") {
    const errorMessage = event.error.errorMessage;
    return {
      type: event.type,
      reason: event.reason,
      ...(errorMessage ? { errorMessage } : {}),
    };
  }
  if (
    event.type === "text_delta" ||
    event.type === "thinking_delta" ||
    event.type === "toolcall_delta"
  ) {
    return {
      type: event.type,
      contentIndex: event.contentIndex,
      delta: event.delta,
    };
  }
  return { type: event.type, contentIndex: event.contentIndex };
};

const modelIdentity = (model: ModelIdentity): ModelIdentity => ({
  provider: model.provider,
  id: model.id,
  name: model.name,
});

const modelOptions = (ctx: ExtensionContext): ModelIdentity[] => {
  const scopedModels = ctx.scopedModels ?? [];
  const availableModels = ctx.modelRegistry?.getAvailable?.() ?? [];
  const models = scopedModels.length
    ? scopedModels.map(({ model }) => model)
    : availableModels.length
      ? availableModels
      : (ctx.modelRegistry?.getAll?.() ?? []);
  return [
    ...new Map(
      models.map((model) => {
        const identity = modelIdentity(model);
        return [`${identity.provider}\0${identity.id}`, identity];
      }),
    ).values(),
  ].slice(0, 256);
};

const statusContextUsage = (ctx: ExtensionContext) => {
  const usage = ctx.getContextUsage();
  return usage && usage.tokens !== null && usage.percent !== null
    ? { ...usage, tokens: usage.tokens, percent: usage.percent }
    : undefined;
};

const messageRole = (event: MessageStartEvent | MessageEndEvent): string => event.message.role;

export const registerLiveEventCapture = (
  pi: ExtensionAPI,
  options: {
    rootDir: string | null;
    env: NodeJS.ProcessEnv;
    onError?: (error: unknown) => void;
  },
): LiveEventCapture => {
  const state: LiveEventCaptureState = { messageSequence: 0 };
  const append = (event: LiveEventPayload) => state.writer?.append(event);
  const updateStatus = (ctx: ExtensionContext, update: PiSessionStatusUpdate) =>
    state.statusWriter?.update({
      contextUsage: statusContextUsage(ctx),
      ...update,
    });

  pi.on("session_info_changed", (event) => append(event));
  pi.on("session_compact", (event) => append(event));
  pi.on("session_tree", (event) => append(event));
  pi.on("agent_start", (event, ctx) => {
    append(event);
    return updateStatus(ctx, { state: "busy" });
  });
  pi.on("agent_end", (event) => append({ type: event.type }));
  pi.on("agent_settled", (event, ctx) => {
    append(event);
    return updateStatus(ctx, { state: "idle" });
  });
  pi.on("turn_start", (event) => append(event));
  pi.on("turn_end", (event, ctx) => {
    append({ type: event.type, turnIndex: event.turnIndex });
    return updateStatus(ctx, {});
  });
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
    if (!activeMessage || activeMessage.role !== "assistant") {
      return;
    }
    append({
      type: event.type,
      messageId: activeMessage.id,
      messageSequence: activeMessage.sequence,
      assistantMessageEvent: compactAssistantMessageEvent(event.assistantMessageEvent),
    });
  });
  pi.on("message_end", (event, ctx) => {
    const activeMessage = state.activeMessage;
    if (!activeMessage) {
      state.messageSequence += 1;
    }
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
    return updateStatus(ctx, {});
  });
  pi.on("tool_execution_start", (event) => append(event));
  pi.on("tool_execution_end", (event) => append(event));
  pi.on("model_select", (event, ctx) => {
    const model = modelIdentity(event.model);
    append({
      type: event.type,
      source: event.source,
      model,
      ...(event.previousModel ? { previousModel: modelIdentity(event.previousModel) } : {}),
    });
    return updateStatus(ctx, { model });
  });
  pi.on("thinking_level_select", (event, ctx) => {
    append(event);
    return updateStatus(ctx, { thinkingLevel: event.level });
  });

  return {
    start: async (event, ctx) => {
      state.messageSequence = 0;
      state.activeMessage = undefined;
      if (!options.rootDir) {
        return;
      }
      try {
        const sessionId = ctx.sessionManager.getSessionId();
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) {
          throw new Error("Pi session has no session file");
        }
        assertSeparateFromSessionFile(options.rootDir, sessionFile);
        state.writer = createLiveEventWriter({
          rootDir: options.rootDir,
          sessionId,
          onError: options.onError,
        });
        const startedAt = Date.now();
        const contextUsage = statusContextUsage(ctx);
        const availableModelOptions = modelOptions(ctx);
        state.statusWriter = createPiSessionStatusWriter({
          rootDir: options.rootDir,
          onError: options.onError,
          status: {
            sessionId,
            sessionFile,
            streamId: state.writer.streamId,
            processInstanceId: PROCESS_INSTANCE_ID,
            pid: process.pid,
            hostname: hostname(),
            ...(options.env.TMUX_PANE ? { tmuxPane: options.env.TMUX_PANE } : {}),
            startedAt,
            state: "idle",
            ...(ctx.model ? { model: modelIdentity(ctx.model) } : {}),
            ...(availableModelOptions.length ? { modelOptions: availableModelOptions } : {}),
            thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
            ...(contextUsage ? { contextUsage } : {}),
          },
        });
        append({
          ...event,
          cwd: ctx.cwd,
          sessionFile,
          pid: process.pid,
        });
        await state.statusWriter.update({});
      } catch (error) {
        state.writer = undefined;
        state.statusWriter = undefined;
        reportError(options.onError, error);
      }
    },
    stop: async (event) => {
      const writer = state.writer;
      const statusWriter = state.statusWriter;
      state.writer = undefined;
      state.statusWriter = undefined;
      state.activeMessage = undefined;
      await Promise.all([writer?.close(event), statusWriter?.close()]);
    },
  };
};
