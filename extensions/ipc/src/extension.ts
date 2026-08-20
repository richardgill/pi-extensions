import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { IpcConfigSchema, type IpcConfig, type IpcConfigInput } from "./config";
import {
  compactAssistantMessageEvent,
  createLiveEventWriter,
  liveEventSessionDir,
  liveEventStreamPath,
  PROCESS_INSTANCE_ID,
  registerLiveEventCapture,
  type CompactAssistantMessageEvent,
  type LiveEventPayload,
  type LiveEventRecord,
  type LiveEventWriter,
} from "./live-events";
import {
  inspectDelegate,
  MESSAGE_TYPE,
  notificationMessage,
  notificationRenderer,
  type DelegateNotificationDetails,
} from "./notification";
import {
  DEFAULT_RUNTIME_DIR,
  ensureRuntimeDir,
  eventKey,
  PARENT_SESSION_ENV,
  parseEnvelope,
  sendEnvelope,
  sendUserMessage,
  socketPathForSession,
  startReceiver,
  TASK_SLUG_ENV,
  TASK_SLUG_PATTERN,
  type DelegateSettledEnvelope,
  type UserMessageRequest,
  type UserMessageResponse,
} from "./protocol";

export { eventKey, PARENT_SESSION_ENV, TASK_SLUG_ENV } from "./protocol";
export { MESSAGE_TYPE, truncatePiJqOutput } from "./notification";
export {
  compactAssistantMessageEvent,
  createLiveEventWriter,
  liveEventSessionDir,
  liveEventStreamPath,
  PROCESS_INSTANCE_ID,
  type CompactAssistantMessageEvent,
  type LiveEventPayload,
  type LiveEventRecord,
  type LiveEventWriter,
} from "./live-events";
export {
  parseEnvelope,
  sendEnvelope,
  sendUserMessage,
  socketPathForSession,
  startReceiver,
  parseUserMessageRequest,
  type DelegateSettledEnvelope,
  type UserMessageInput,
  type UserMessageRequest,
  type UserMessageResponse,
} from "./protocol";

export const RECEIPT_TYPE = "pi-ipc.delegate-settled-receipt";

export type IpcOptions = IpcConfigInput & {
  env?: NodeJS.ProcessEnv;
  runtimeDir?: string;
  ackTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
  onLiveEventError?: (error: unknown) => void;
};

const restoreReceipts = (ctx: ExtensionContext) => {
  const receipts = new Map<string, DelegateSettledEnvelope>();
  const delivered = new Set<string>();
  ctx.sessionManager.getEntries().forEach((entry) => {
    if (entry.type === "custom" && entry.customType === RECEIPT_TYPE) {
      const envelope = parseEnvelope(JSON.stringify(entry.data));
      if (envelope) receipts.set(eventKey(envelope), envelope);
    }
    if (entry.type === "custom_message" && entry.customType === MESSAGE_TYPE) {
      const envelope = parseEnvelope(JSON.stringify(entry.details));
      if (envelope) delivered.add(eventKey(envelope));
    }
  });
  return {
    eventKeys: new Set(receipts.keys()),
    pending: [...receipts.values()].filter((envelope) => !delivered.has(eventKey(envelope))),
  };
};

const requiredTaskSlug = (taskSlug: string | undefined): string => {
  if (!taskSlug || !TASK_SLUG_PATTERN.test(taskSlug)) {
    throw new Error(`Delegated Pi requires a valid ${TASK_SLUG_ENV}`);
  }
  return taskSlug;
};

const rememberResponse = (
  responses: Map<string, UserMessageResponse>,
  response: UserMessageResponse,
): UserMessageResponse => {
  responses.set(response.requestId, response);
  if (responses.size > 128) responses.delete(responses.keys().next().value!);
  return response;
};

const injectNotification = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  envelope: DelegateSettledEnvelope,
  signal: AbortSignal,
  config: IpcConfig,
): Promise<void> => {
  if (signal.aborted) return;
  const details = await inspectDelegate(pi, envelope, signal, config);
  if (signal.aborted) return;
  pi.sendMessage(
    notificationMessage(envelope, details, config),
    ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" },
  );
};

export const ipc = (pi: ExtensionAPI, options: IpcOptions = {}): void => {
  pi.registerMessageRenderer<DelegateNotificationDetails>(MESSAGE_TYPE, notificationRenderer);

  const { inspectionCommand, inspectionTimeoutMs, supervisionPrompt, liveEventsDir } = options;
  const config = IpcConfigSchema.parse({
    inspectionCommand,
    inspectionTimeoutMs,
    supervisionPrompt,
    liveEventsDir,
  });
  const env = options.env ?? process.env;
  const isDelegate = env.PI_DELEGATE === "1";
  const parentSessionId = isDelegate ? env[PARENT_SESSION_ENV] : undefined;
  const delegateTaskSlug = isDelegate ? requiredTaskSlug(env[TASK_SLUG_ENV]) : undefined;
  const runtimeDir = options.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const parentSocket = parentSessionId
    ? socketPathForSession(parentSessionId, runtimeDir)
    : undefined;
  let receiver: Awaited<ReturnType<typeof startReceiver>> | undefined;
  let activeSessionId: string | undefined;
  let sessionController: AbortController | undefined;
  let eventKeys = new Set<string>();
  let userMessageResponses = new Map<string, UserMessageResponse>();
  const liveEvents = registerLiveEventCapture(pi, {
    rootDir: config.liveEventsDir,
    onError: options.onLiveEventError,
  });

  pi.on("session_start", async (event, ctx) => {
    liveEvents.start(event, ctx);
    const previousReceiver = receiver;
    receiver = undefined;
    sessionController?.abort();
    const controller = new AbortController();
    sessionController = controller;
    userMessageResponses = new Map();
    await previousReceiver?.close();
    const ownSessionId = ctx.sessionManager.getSessionId();
    activeSessionId = ownSessionId;
    const restored = restoreReceipts(ctx);
    eventKeys = restored.eventKeys;
    await ensureRuntimeDir(runtimeDir);
    const startedReceiver = await startReceiver(
      socketPathForSession(ownSessionId, runtimeDir),
      (envelope) => {
        if (controller.signal.aborted || sessionController !== controller) return;
        const key = eventKey(envelope);
        if (eventKeys.has(key)) return;
        pi.appendEntry(RECEIPT_TYPE, envelope);
        eventKeys.add(key);
        void injectNotification(pi, ctx, envelope, controller.signal, config).catch(
          () => undefined,
        );
      },
      {
        onUserMessage: (request: UserMessageRequest): UserMessageResponse => {
          const previous = userMessageResponses.get(request.requestId);
          if (previous) return previous;
          if (controller.signal.aborted || sessionController !== controller) {
            return rememberResponse(userMessageResponses, {
              version: 1,
              requestId: request.requestId,
              ok: false,
              error: "shutting_down",
            });
          }
          const isIdle = ctx.isIdle();
          const delivery = isIdle ? "immediate" : request.deliverAs;
          const userMessageOptions = isIdle
            ? { expandPromptTemplates: request.expandPromptTemplates }
            : {
                deliverAs: request.deliverAs,
                expandPromptTemplates: request.expandPromptTemplates,
              };
          try {
            pi.sendUserMessage(request.message, userMessageOptions);
            return rememberResponse(userMessageResponses, {
              version: 1,
              requestId: request.requestId,
              ok: true,
              delivery,
            });
          } catch {
            return rememberResponse(userMessageResponses, {
              version: 1,
              requestId: request.requestId,
              ok: false,
              error: "unavailable",
            });
          }
        },
      },
    );
    if (controller.signal.aborted || sessionController !== controller) {
      await startedReceiver.close();
      return;
    }
    receiver = startedReceiver;
    await Promise.all(
      restored.pending.map((envelope) =>
        injectNotification(pi, ctx, envelope, controller.signal, config),
      ),
    );
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const childSessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    if (!parentSocket || !leafId || !delegateTaskSlug) return;

    await sendEnvelope(
      parentSocket,
      {
        childSessionId,
        taskSlug: delegateTaskSlug,
        leafId,
        cwd: ctx.cwd,
        timestamp: Date.now(),
      },
      {
        ackTimeoutMs: options.ackTimeoutMs,
        retryDelaysMs: options.retryDelaysMs,
      },
    );
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (ctx.sessionManager.getSessionId() !== activeSessionId) return;
    const ownedReceiver = receiver;
    receiver = undefined;
    activeSessionId = undefined;
    sessionController?.abort();
    sessionController = undefined;
    await Promise.all([ownedReceiver?.close(), liveEvents.stop(event)]);
  });
};
