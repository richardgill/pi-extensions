import type {
  AgentToolUpdateCallback,
  BashToolDetails,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { tmuxBash } from "../../src/extension.js";
import type { BashInput } from "../../src/tool-call-schemas.js";
import type { TempPiProject } from "./temp-project.js";

export type TimedToolUpdate = {
  elapsedMs: number;
  text: string;
};

export type DirectBashRunResult = {
  text: string;
  updates: TimedToolUpdate[];
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

  return {
    tools,
    handlers,
    on: (name: string, handler: EventHandler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
  } as unknown as FakePi;
};

const createContext = (project: TempPiProject): ExtensionContext =>
  ({
    cwd: project.projectDir,
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

export const runBashToolDirectly = async (
  project: TempPiProject,
  input: BashInput,
): Promise<DirectBashRunResult> => {
  const pi = createFakePi();
  const ctx = createContext(project);
  const updates: TimedToolUpdate[] = [];
  const startedAt = Date.now();
  const onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> = (update) => {
    updates.push({ elapsedMs: Date.now() - startedAt, text: updateText(update) });
  };

  tmuxBash({ outputDir: project.outputDir, preserveOutputFiles: true })(pi);
  await emit(pi, "session_start", ctx);

  try {
    const result = await registeredBashTool(pi).execute(
      "direct-bash",
      input,
      undefined,
      onUpdate,
      ctx,
    );
    return { text: resultText(result), updates };
  } finally {
    await emit(pi, "session_shutdown", ctx);
  }
};
