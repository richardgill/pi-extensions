import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import {
  completeSimple,
  type AssistantMessage,
  type Message,
  type UserMessage,
} from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import {
  collectFileEventsForTurnFromSessionFile,
  type FileLineEvent,
} from "@richardgill/pi-file-collector";
import { z } from "zod";

const execFileAsync = promisify(execFile);

type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export type TaskContextModelOptions = {
  provider: string;
  id: string;
  thinkingLevel?: ThinkingLevel;
};

export type TaskContextCommandOptions = {
  command: string;
  args?: string[];
  title?: string;
  maxOutputChars?: number;
};

export type TaskContextOptions = {
  outputPath?: string;
  currentOutputPath?: string | false;
  maxSnapshots?: number;
  model?: TaskContextModelOptions;
  customCommands?: TaskContextCommandOptions[];
  jsonShape?: string;
  updaterPrompt?: string;
  updateInstructions?: string;
  assistantTextMaxChars?: number;
  toolResultContentMaxChars?: number;
  maxToolResults?: number;
  maxFileEvents?: number;
};

type ResolvedOptions = Required<Omit<TaskContextOptions, "model" | "currentOutputPath">> & {
  currentOutputPath?: string | false;
  model: Required<TaskContextModelOptions>;
};

type NovelCommand = {
  command: string;
  notes: string;
};

type RelevantFileRange = {
  start: number;
  end: number;
};

type WholeRelevantFile = {
  path: string;
  role: string;
  whyImportant: string;
  type: "whole_file";
};

type RangeRelevantFile = {
  path: string;
  role: string;
  whyImportant: string;
  type: "range";
  ranges: RelevantFileRange[];
};

export type TaskContextSnapshot = {
  title: string;
  autoUpdatedAt: string;
  novelUserContext: string[];
  novelCommands: NovelCommand[];
  relevantFiles: Array<WholeRelevantFile | RangeRelevantFile>;
};

type EvidenceToolResult = {
  toolName: string;
  isError: boolean;
  content: string;
};

type EvidenceFileEvent = {
  path: string;
  source: FileLineEvent["source"];
  startLine?: number;
  endLine?: number;
  display?: string;
};

type EvidencePacket = {
  previousSnapshot: TaskContextSnapshot;
  turn: {
    turnIndex: number;
    assistantText: string;
    toolResults: EvidenceToolResult[];
  };
  fileEvents: EvidenceFileEvent[];
};

type TaskContextRuntime = {
  cwd: string;
  sessionFile: string | undefined;
  modelRegistry: ExtensionContext["modelRegistry"];
};

type UpdateTaskContextJsonlInput = {
  runtime: TaskContextRuntime;
  turn: TurnEndEvent;
  fileEvents: FileLineEvent[];
  options: ResolvedOptions;
  now?: Date;
  completeSnapshot?: (evidence: EvidencePacket) => Promise<unknown>;
};

type TaskContextCommandInput = {
  cwd: string;
  options: ResolvedOptions;
};

type CustomCommandResult = {
  config: TaskContextCommandOptions;
  stdout: string;
  stderr: string;
  exitCode?: number;
  error?: string;
};

const DEFAULT_JSON_SHAPE = JSON.stringify(
  {
    title: "",
    autoUpdatedAt: "",
    novelUserContext: ["durable user-provided context that is not obvious or cheap to rediscover"],
    novelCommands: [{ command: "shell command", notes: "why it is useful" }],
    relevantFiles: [
      { path: "./path/to/file.ts", role: "implementation", whyImportant: "", type: "whole_file" },
      {
        path: "./path/to/file.ts",
        role: "reference",
        whyImportant: "",
        type: "range",
        ranges: [{ start: 1, end: 10 }],
      },
    ],
  },
  null,
  2,
);

const DEFAULT_UPDATER_PROMPT = [
  "You update a task-context JSON snapshot after one Pi turn.",
  "Return exactly one JSON object and no markdown. Do not include unknown keys.",
  "Use this exact shape:",
  "{{jsonShape}}",
  "Empty arrays are valid. novelCommands must be objects, never strings. relevantFiles must use one of the two shown object shapes.",
  "Preserve useful existing context. Keep the snapshot concise.",
  "{{updateInstructions}}",
].join("\n");

export const DEFAULT_OPTIONS: ResolvedOptions = {
  outputPath: "./overlay/task-context.jsonl",
  currentOutputPath: undefined,
  maxSnapshots: 20,
  model: {
    provider: "openai",
    id: "gpt-5.2",
    thinkingLevel: "medium",
  },
  jsonShape: DEFAULT_JSON_SHAPE,
  updaterPrompt: DEFAULT_UPDATER_PROMPT,
  updateInstructions:
    "Keep entries concise. Preserve useful existing context. Only include files that matter for resuming the task.",
  customCommands: [],
  assistantTextMaxChars: 6000,
  toolResultContentMaxChars: 2000,
  maxToolResults: 20,
  maxFileEvents: 80,
};

const RangeSchema = z
  .object({
    start: z.number().int().positive(),
    end: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.end >= range.start, "range end must be greater than or equal to start");

const WholeRelevantFileSchema = z
  .object({
    path: z.string(),
    role: z.string(),
    whyImportant: z.string(),
    type: z.literal("whole_file"),
  })
  .strict();

const RangeRelevantFileSchema = z
  .object({
    path: z.string(),
    role: z.string(),
    whyImportant: z.string(),
    type: z.literal("range"),
    ranges: z.array(RangeSchema),
  })
  .strict();

const NovelCommandSchema = z
  .object({
    command: z.string(),
    notes: z.string(),
  })
  .strict();

const SnapshotBaseSchema = z
  .object({
    title: z.string(),
    novelUserContext: z.array(z.string()),
    novelCommands: z.array(NovelCommandSchema),
    relevantFiles: z.array(
      z.discriminatedUnion("type", [WholeRelevantFileSchema, RangeRelevantFileSchema]),
    ),
  })
  .strict();

export const TaskContextSnapshotSchema = SnapshotBaseSchema.extend({
  autoUpdatedAt: z.string(),
}).strict();

const ModelOutputSchema = SnapshotBaseSchema.extend({
  autoUpdatedAt: z.string().optional(),
}).strict();

const EMPTY_SNAPSHOT: TaskContextSnapshot = {
  title: "",
  autoUpdatedAt: "",
  novelUserContext: [],
  novelCommands: [],
  relevantFiles: [],
};

const TaskContextOptionsSchema = z.object({
  outputPath: z.string().default(DEFAULT_OPTIONS.outputPath),
  currentOutputPath: z.union([z.string(), z.literal(false)]).optional(),
  maxSnapshots: z.number().int().positive().default(DEFAULT_OPTIONS.maxSnapshots),
  model: z
    .object({
      provider: z.string().default(DEFAULT_OPTIONS.model.provider),
      id: z.string().default(DEFAULT_OPTIONS.model.id),
      thinkingLevel: z
        .enum(["minimal", "low", "medium", "high", "xhigh"])
        .default(DEFAULT_OPTIONS.model.thinkingLevel),
    })
    .default(DEFAULT_OPTIONS.model),
  customCommands: z
    .array(z.custom<TaskContextCommandOptions>())
    .default(() => [...DEFAULT_OPTIONS.customCommands]),
  jsonShape: z.string().default(DEFAULT_OPTIONS.jsonShape),
  updaterPrompt: z.string().default(DEFAULT_OPTIONS.updaterPrompt),
  updateInstructions: z.string().default(DEFAULT_OPTIONS.updateInstructions),
  assistantTextMaxChars: z.number().int().positive().default(DEFAULT_OPTIONS.assistantTextMaxChars),
  toolResultContentMaxChars: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_OPTIONS.toolResultContentMaxChars),
  maxToolResults: z.number().int().positive().default(DEFAULT_OPTIONS.maxToolResults),
  maxFileEvents: z.number().int().positive().default(DEFAULT_OPTIONS.maxFileEvents),
});

export const resolveOptions = (input: TaskContextOptions = {}): ResolvedOptions =>
  TaskContextOptionsSchema.parse(input);

const expandHome = (targetPath: string): string => {
  if (targetPath === "~") {
    return os.homedir();
  }

  return targetPath.startsWith(`~${path.sep}`)
    ? path.join(os.homedir(), targetPath.slice(2))
    : targetPath;
};

export const resolveOutputPath = (targetPath: string, cwd: string): string => {
  const expanded = expandHome(targetPath);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded);
};

const deriveCurrentOutputPath = (outputPath: string): string => {
  if (outputPath.endsWith(".jsonl")) {
    return `${outputPath.slice(0, -".jsonl".length)}.json`;
  }

  return `${outputPath}.current.json`;
};

export const resolveCurrentOutputPath = (
  outputPath: string,
  currentOutputPath: string | false | undefined,
  cwd: string,
): string | undefined => {
  if (currentOutputPath === false) {
    return undefined;
  }

  return resolveOutputPath(currentOutputPath ?? deriveCurrentOutputPath(outputPath), cwd);
};

const readJsonlLines = async (filePath: string): Promise<string[]> => {
  try {
    const content = await readFile(filePath, "utf8");
    return content.split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
};

const parseStoredSnapshot = (value: unknown): TaskContextSnapshot => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return TaskContextSnapshotSchema.parse(value);
  }

  const {
    goal: _goal,
    verification: _verification,
    outstanding: _outstanding,
    openQuestions: _openQuestions,
    decisions: _decisions,
    learned: _learned,
    constraints: _constraints,
    assumptions: _assumptions,
    contextCommands: _contextCommands,
    ...snapshot
  } = value as Record<string, unknown>;

  return TaskContextSnapshotSchema.parse({ novelUserContext: [], novelCommands: [], ...snapshot });
};

export const readLatestSnapshot = async (filePath: string): Promise<TaskContextSnapshot> => {
  const firstLine = (await readJsonlLines(filePath)).at(0);
  if (!firstLine) {
    return EMPTY_SNAPSHOT;
  }

  return parseStoredSnapshot(JSON.parse(firstLine));
};

const readSnapshotFile = async (filePath: string): Promise<TaskContextSnapshot | undefined> => {
  try {
    return parseStoredSnapshot(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
};

const readCurrentOrLatestSnapshot = async ({
  cwd,
  options,
}: TaskContextCommandInput): Promise<TaskContextSnapshot> => {
  const outputPath = resolveOutputPath(options.outputPath, cwd);
  const currentOutputPath = resolveCurrentOutputPath(
    options.outputPath,
    options.currentOutputPath,
    cwd,
  );
  const current = currentOutputPath ? await readSnapshotFile(currentOutputPath) : undefined;
  return current ?? readLatestSnapshot(outputPath);
};

const atomicWrite = async (filePath: string, content: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
};

export const prependSnapshot = async (
  filePath: string,
  snapshot: TaskContextSnapshot,
  maxSnapshots: number,
): Promise<void> => {
  const existingLines = await readJsonlLines(filePath);
  const lines = [JSON.stringify(snapshot), ...existingLines].slice(0, maxSnapshots);
  await atomicWrite(filePath, `${lines.join("\n")}\n`);
};

export const writeCurrentSnapshot = async (
  filePath: string | undefined,
  snapshot: TaskContextSnapshot,
): Promise<void> => {
  if (!filePath) {
    return;
  }

  await atomicWrite(filePath, `${JSON.stringify(snapshot, null, 2)}\n`);
};

const truncateText = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}… [truncated ${value.length - maxChars} chars]`;
};

const extractTextContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      const text = (part as { text?: unknown } | undefined)?.text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
};

const getAssistantText = (message: Message, options: ResolvedOptions): string => {
  if (message.role !== "assistant") {
    return "";
  }

  return truncateText(extractTextContent(message.content), options.assistantTextMaxChars);
};

const buildToolResultsEvidence = (
  toolResults: TurnEndEvent["toolResults"],
  options: ResolvedOptions,
): EvidenceToolResult[] =>
  toolResults.slice(0, options.maxToolResults).map((result) => ({
    toolName: result.toolName,
    isError: result.isError,
    content: truncateText(extractTextContent(result.content), options.toolResultContentMaxChars),
  }));

const buildFileEventsEvidence = (
  fileEvents: FileLineEvent[],
  options: ResolvedOptions,
): EvidenceFileEvent[] =>
  fileEvents.slice(0, options.maxFileEvents).map((event) => ({
    path: event.path,
    source: event.source,
    ...(event.startLine ? { startLine: event.startLine } : {}),
    ...(event.endLine ? { endLine: event.endLine } : {}),
    ...(event.display ? { display: event.display } : {}),
  }));

export const buildEvidencePacket = (
  previousSnapshot: TaskContextSnapshot,
  turn: TurnEndEvent,
  fileEvents: FileLineEvent[],
  options: ResolvedOptions,
): EvidencePacket => ({
  previousSnapshot,
  turn: {
    turnIndex: turn.turnIndex,
    assistantText: getAssistantText(turn.message as Message, options),
    toolResults: buildToolResultsEvidence(turn.toolResults, options),
  },
  fileEvents: buildFileEventsEvidence(fileEvents, options),
});

const getMarkdownFence = (content: string): string => (content.includes("```") ? "````" : "```");

const getLanguage = (filePath: string): string => {
  if (filePath === "shell") return "sh";
  if (filePath === "txt") return "text";

  const extension = path.extname(filePath).slice(1);
  if (extension === "ts" || extension === "tsx") return "ts";
  if (extension === "js" || extension === "jsx") return "js";
  if (extension === "json" || extension === "jsonl" || extension === "jsonc") return "json";
  if (extension === "md") return "md";
  return "";
};

const formatCodeBlock = (filePath: string, content: string): string => {
  const fence = getMarkdownFence(content);
  return `${fence}${getLanguage(filePath)}\n${content}\n${fence}`;
};

const getRelevantFileLabel = (file: TaskContextSnapshot["relevantFiles"][number]): string => {
  if (file.type === "whole_file") {
    return file.path;
  }

  return file.ranges.map((range) => `${file.path}:${range.start}-${range.end}`).join(", ");
};

const formatRelevantFileLoaded = (file: TaskContextSnapshot["relevantFiles"][number]): string =>
  `- \`${getRelevantFileLabel(file)}\` — ${file.role}: ${file.whyImportant}`;

const truncateCommandOutput = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
};

const maybeTruncateCommandOutput = (value: string, maxChars: number | undefined): string =>
  maxChars === undefined ? value : truncateCommandOutput(value, maxChars);

const resolveCommandPath = (command: string): string =>
  command.startsWith(`~${path.sep}`) ? path.join(os.homedir(), command.slice(2)) : command;

const getCommandErrorCode = (error: unknown): number | undefined => {
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
};

const runCustomCommand = async (
  cwd: string,
  config: TaskContextCommandOptions,
): Promise<CustomCommandResult> => {
  try {
    const result = await execFileAsync(resolveCommandPath(config.command), config.args ?? [], {
      cwd,
      shell: false,
      maxBuffer: 1024 * 1024 * 10,
    });
    return {
      config,
      stdout: maybeTruncateCommandOutput(result.stdout, config.maxOutputChars),
      stderr: maybeTruncateCommandOutput(result.stderr, config.maxOutputChars),
    };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; message?: string };
    return {
      config,
      stdout: maybeTruncateCommandOutput(result.stdout ?? "", config.maxOutputChars),
      stderr: maybeTruncateCommandOutput(result.stderr ?? "", config.maxOutputChars),
      exitCode: getCommandErrorCode(error),
      error: result.message,
    };
  }
};

const formatCommandInvocation = (config: TaskContextCommandOptions): string =>
  [config.command, ...(config.args ?? [])].join(" ");

const getCommandLoadedText = (result: CustomCommandResult): string => {
  const invocation = formatCommandInvocation(result.config);
  const exit = result.exitCode === undefined ? "" : ` Exit code: ${result.exitCode}.`;
  return `- Ran \`${invocation}\` and loaded its output.${exit}`;
};

const formatCustomCommandOutput = (result: CustomCommandResult): string => {
  const title = result.config.title ?? formatCommandInvocation(result.config);
  const status = result.exitCode === undefined ? [] : ["", `Exit code: ${result.exitCode}`];
  return [
    `### ${title}`,
    "",
    "Command:",
    "",
    formatCodeBlock("shell", formatCommandInvocation(result.config)),
    ...status,
    "",
    "Stdout:",
    "",
    formatCodeBlock("txt", result.stdout || "(empty)"),
    "",
    "Stderr:",
    "",
    formatCodeBlock("txt", result.stderr || result.error || "(empty)"),
  ].join("\n");
};

const runCustomCommands = (cwd: string, options: ResolvedOptions): Promise<CustomCommandResult[]> =>
  Promise.all(options.customCommands.map((config) => runCustomCommand(cwd, config)));

const getDisplaySnapshot = (snapshot: TaskContextSnapshot): TaskContextSnapshot => ({
  ...snapshot,
  relevantFiles: snapshot.relevantFiles.length > 0 ? (["..."] as never) : [],
});

const getCustomCommandsLoaded = (results: CustomCommandResult[]): string => {
  if (results.length === 0) {
    return "- No custom commands configured.";
  }

  return results.map(getCommandLoadedText).join("\n");
};

const getRelevantFilesLoaded = (snapshot: TaskContextSnapshot): string => {
  if (snapshot.relevantFiles.length === 0) {
    return "- No relevant files recorded.";
  }

  return snapshot.relevantFiles.map(formatRelevantFileLoaded).join("\n");
};

const getLoadedCommandOutputs = (results: CustomCommandResult[]): string =>
  results.map(formatCustomCommandOutput).join("\n\n");

const resolveRelevantFilePath = (cwd: string, filePath: string): string =>
  path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

const rangeLabel = (filePath: string, range: RelevantFileRange): string =>
  `${filePath}:${range.start}-${range.end}`;

const sliceRange = (content: string, range: RelevantFileRange): string =>
  content
    .split("\n")
    .slice(range.start - 1, range.end)
    .join("\n");

const formatLoadedFileBlock = (label: string, filePath: string, content: string): string =>
  [`### ${label}`, "", formatCodeBlock(filePath, content)].join("\n");

const formatReadErrorBlock = (label: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return [`### ${label}`, "", `Could not read file: ${message}`].join("\n");
};

const loadWholeRelevantFile = async (cwd: string, file: WholeRelevantFile): Promise<string> => {
  try {
    const content = await readFile(resolveRelevantFilePath(cwd, file.path), "utf8");
    return formatLoadedFileBlock(file.path, file.path, content);
  } catch (error) {
    return formatReadErrorBlock(file.path, error);
  }
};

const loadRangeRelevantFile = async (cwd: string, file: RangeRelevantFile): Promise<string> => {
  try {
    const content = await readFile(resolveRelevantFilePath(cwd, file.path), "utf8");
    return file.ranges
      .map((range) =>
        formatLoadedFileBlock(rangeLabel(file.path, range), file.path, sliceRange(content, range)),
      )
      .join("\n\n");
  } catch (error) {
    return file.ranges
      .map((range) => formatReadErrorBlock(rangeLabel(file.path, range), error))
      .join("\n\n");
  }
};

const loadRelevantFile = (
  cwd: string,
  file: TaskContextSnapshot["relevantFiles"][number],
): Promise<string> =>
  file.type === "whole_file" ? loadWholeRelevantFile(cwd, file) : loadRangeRelevantFile(cwd, file);

const getLoadedRelevantFileContents = async (
  cwd: string,
  snapshot: TaskContextSnapshot,
): Promise<string> => {
  if (snapshot.relevantFiles.length === 0) {
    return "- No relevant files recorded.";
  }

  const loadedFiles = await Promise.all(
    snapshot.relevantFiles.map((file) => loadRelevantFile(cwd, file)),
  );
  return loadedFiles.join("\n\n");
};

export const buildTaskContextMarkdown = async ({
  cwd,
  options,
}: TaskContextCommandInput): Promise<string> => {
  const snapshot = await readCurrentOrLatestSnapshot({ cwd, options });
  const [commandResults, loadedRelevantFileContents] = await Promise.all([
    runCustomCommands(cwd, options),
    getLoadedRelevantFileContents(cwd, snapshot),
  ]);
  return [
    "# Task Context",
    "",
    "## Current Snapshot",
    "",
    "```json",
    JSON.stringify(getDisplaySnapshot(snapshot), null, 2),
    "```",
    "",
    "## Custom Commands",
    "",
    getCustomCommandsLoaded(commandResults),
    "",
    "## Relevant Files Loaded",
    "",
    getRelevantFilesLoaded(snapshot),
    "",
    "## Loaded Relevant File Contents",
    "",
    loadedRelevantFileContents,
    "",
    "## Loaded Command Outputs",
    "",
    getLoadedCommandOutputs(commandResults),
  ].join("\n");
};

const renderUpdaterPromptTemplate = (
  template: string,
  values: Pick<ResolvedOptions, "jsonShape" | "updateInstructions">,
): string =>
  template.replace(/{{\s*(jsonShape|updateInstructions)\s*}}/g, (_match, key: string) =>
    key === "jsonShape" ? values.jsonShape : values.updateInstructions,
  );

export const buildUpdaterSystemPrompt = (
  options: Pick<ResolvedOptions, "updaterPrompt" | "jsonShape" | "updateInstructions">,
): string => renderUpdaterPromptTemplate(options.updaterPrompt, options).trim();

const parseModelOutput = (value: string): unknown => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("Task-context model output was not exactly one JSON object");
  }

  return JSON.parse(trimmed);
};

export const validateModelSnapshot = (value: unknown, now: Date): TaskContextSnapshot => {
  const snapshot = ModelOutputSchema.parse(value);
  return TaskContextSnapshotSchema.parse({ ...snapshot, autoUpdatedAt: now.toISOString() });
};

const getResponseText = (message: AssistantMessage): string =>
  message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const completeSnapshotWithModel = async (
  runtime: TaskContextRuntime,
  options: ResolvedOptions,
  evidence: EvidencePacket,
): Promise<unknown> => {
  const model = runtime.modelRegistry.find(options.model.provider, options.model.id);
  if (!model) {
    throw new Error(`Model ${options.model.provider}/${options.model.id} not found`);
  }

  const auth = await runtime.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(
      auth.ok ? `No API key for ${options.model.provider}/${options.model.id}` : auth.error,
    );
  }

  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: JSON.stringify(evidence) }],
    timestamp: Date.now(),
  };
  const response = await completeSimple(
    model,
    { systemPrompt: buildUpdaterSystemPrompt(options), messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, reasoning: options.model.thinkingLevel },
  );

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? `Task-context model stopped: ${response.stopReason}`);
  }

  return parseModelOutput(getResponseText(response));
};

export const updateTaskContextJsonl = async ({
  runtime,
  turn,
  fileEvents,
  options,
  now = new Date(),
  completeSnapshot,
}: UpdateTaskContextJsonlInput): Promise<TaskContextSnapshot> => {
  const outputPath = resolveOutputPath(options.outputPath, runtime.cwd);
  const currentOutputPath = resolveCurrentOutputPath(
    options.outputPath,
    options.currentOutputPath,
    runtime.cwd,
  );
  const previousSnapshot = await readLatestSnapshot(outputPath);
  const evidence = buildEvidencePacket(previousSnapshot, turn, fileEvents, options);
  const modelOutput = completeSnapshot
    ? await completeSnapshot(evidence)
    : await completeSnapshotWithModel(runtime, options, evidence);
  const nextSnapshot = validateModelSnapshot(modelOutput, now);
  await writeCurrentSnapshot(currentOutputPath, nextSnapshot);
  await prependSnapshot(outputPath, nextSnapshot, options.maxSnapshots);
  return nextSnapshot;
};

const logFailure = (error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`task-context update failed: ${message}`);
};

const createTaskContextRuntime = (ctx: ExtensionContext): TaskContextRuntime => ({
  cwd: ctx.cwd,
  sessionFile: ctx.sessionManager.getSessionFile(),
  modelRegistry: ctx.modelRegistry,
});

type BackgroundUpdateInput = {
  runtime: TaskContextRuntime;
  turn: TurnEndEvent;
  options: ResolvedOptions;
};

const updateTaskContextAfterTurn = async ({
  runtime,
  turn,
  options,
}: BackgroundUpdateInput): Promise<void> => {
  const fileEvents = await collectFileEventsForTurnFromSessionFile(
    runtime.sessionFile,
    turn.turnIndex,
    { dedupe: true },
  );
  await updateTaskContextJsonl({ runtime, turn, fileEvents, options });
};

const runBackgroundUpdate = async (input: BackgroundUpdateInput): Promise<void> => {
  try {
    await updateTaskContextAfterTurn(input);
  } catch (error) {
    logFailure(error);
  }
};

const enqueueBackgroundUpdate = (
  queue: Promise<void>,
  input: BackgroundUpdateInput,
  onSettled: () => void,
): Promise<void> =>
  queue.then(async () => {
    await runBackgroundUpdate(input);
    onSettled();
  });

const prepareTaskContext = async (
  ctx: ExtensionCommandContext,
  options: ResolvedOptions,
): Promise<string> => buildTaskContextMarkdown({ cwd: ctx.cwd, options });

const showTaskContextPreview = (pi: ExtensionAPI, markdown: string): void => {
  pi.sendMessage({
    customType: "task-context-preview",
    content: markdown,
    display: true,
  });
};

const notifyTaskContextPrepared = (ctx: ExtensionCommandContext): void => {
  if (!ctx.hasUI) {
    return;
  }

  ctx.ui.notify("Task context will be included in the next turn.", "info");
};

export const taskContext = (input: TaskContextOptions = {}) => {
  const options = resolveOptions(input);

  return (pi: ExtensionAPI): void => {
    const runtimes = new Map<number, TaskContextRuntime>();
    let lastRuntime: TaskContextRuntime | undefined;
    let pendingTaskContext: string | undefined;

    pi.registerCommand("task-context", {
      description: "Include current task context and relevant file contents in the next turn.",
      handler: async (_args, ctx) => {
        pendingTaskContext = await prepareTaskContext(ctx, options);
        showTaskContextPreview(pi, pendingTaskContext);
        notifyTaskContextPrepared(ctx);
      },
    });

    pi.on("before_agent_start", async (event) => {
      if (!pendingTaskContext) {
        return;
      }

      const context = pendingTaskContext;
      pendingTaskContext = undefined;
      return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
    });

    pi.on("turn_start", async (event, ctx) => {
      try {
        const runtime = createTaskContextRuntime(ctx);
        lastRuntime = runtime;
        runtimes.set(event.turnIndex, runtime);
      } catch {}
    });

    let backgroundUpdateQueue: Promise<void> = Promise.resolve();

    pi.on("turn_end", (event, ctx) => {
      const runtime = runtimes.get(event.turnIndex) ?? lastRuntime ?? createTaskContextRuntime(ctx);
      backgroundUpdateQueue = enqueueBackgroundUpdate(
        backgroundUpdateQueue,
        { runtime, turn: event, options },
        () => runtimes.delete(event.turnIndex),
      );
    });
  };
};

export const extension = (input: TaskContextOptions = {}) => taskContext(input);
