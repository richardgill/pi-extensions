// Direct test harness for the tmux-bash bash tool, without launching pi.
import type {
  AgentToolUpdateCallback,
  BashToolDetails,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { tmuxBash } from "../../src/extension";
import type { BashInput } from "../../src/tool-call-schemas";
import type { PiTestWorkspace } from "./pi-test-workspace";

export type TimedToolUpdate = {
  elapsedMs: number;
  text: string;
};

export type DirectMessage = {
  customType?: string;
  content?: string;
  triggerTurn?: boolean;
  deliverAs?: string;
};

export type DirectBashRunOptions = {
  waitAfterExecuteMs?: number;
};

export type DirectBashRunResult = {
  text: string;
  updates: TimedToolUpdate[];
  messages: DirectMessage[];
};

type ToolResult = {
  content?: { type: string; text?: string }[];
  details?: BashToolDetails;
};

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
    ctx: ExtensionContext,
  ) => Promise<ToolResult>;
};

type EventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

type FakePi = ExtensionAPI & {
  tools: RegisteredTool[];
  handlers: Map<string, EventHandler[]>;
  messages: DirectMessage[];
};

const resultText = (result: ToolResult): string => {
  const content = result.content?.[0];
  return content?.type === "text" ? (content.text ?? "") : "";
};

const updateText = (update: ToolResult): string => {
  const content = update.content?.[0];
  return content?.type === "text" ? (content.text ?? "") : "";
};

const createFakePi = (): FakePi => {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, EventHandler[]>();
  const messages: DirectMessage[] = [];

  return {
    tools,
    handlers,
    messages,
    on: (name: string, handler: EventHandler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    sendMessage: (message: DirectMessage, options?: DirectMessage) => {
      messages.push({ ...message, ...options });
    },
    sendUserMessage: () => {},
  } as unknown as FakePi;
};

const createContext = (workspace: PiTestWorkspace): ExtensionContext =>
  ({
    cwd: workspace.projectDir,
    hasUI: false,
    sessionManager: { getSessionId: () => "direct-tool-test" },
    ui: { setStatus: () => {} },
  }) as unknown as ExtensionContext;

const emit = async (pi: FakePi, name: string, ctx: ExtensionContext): Promise<void> => {
  for (const handler of pi.handlers.get(name) ?? []) {
    await handler({}, ctx);
  }
};

const registeredBashTool = (pi: FakePi): RegisteredTool => {
  const tool = pi.tools.find((item) => item.name === "bash");
  if (!tool) throw new Error("bash tool was not registered");
  return tool;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const runBashToolDirectly = async (
  workspace: PiTestWorkspace,
  input: BashInput,
  options: DirectBashRunOptions = {},
): Promise<DirectBashRunResult> => {
  const pi = createFakePi();
  const ctx = createContext(workspace);
  const updates: TimedToolUpdate[] = [];
  const startedAt = Date.now();
  const onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> = (update) => {
    updates.push({ elapsedMs: Date.now() - startedAt, text: updateText(update) });
  };

  tmuxBash(workspace.tmuxBashConfig)(pi);
  await emit(pi, "session_start", ctx);

  try {
    const result = await registeredBashTool(pi).execute(
      "direct-bash",
      input,
      undefined,
      onUpdate,
      ctx,
    );
    if (options.waitAfterExecuteMs) await sleep(options.waitAfterExecuteMs);
    return { text: resultText(result), updates, messages: pi.messages };
  } finally {
    await emit(pi, "session_shutdown", ctx);
  }
};
