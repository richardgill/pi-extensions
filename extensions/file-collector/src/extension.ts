import { realpathSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isBashToolResult,
  isEditToolResult,
  isReadToolResult,
  isToolCallEventType,
  isWriteToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { resolveOptions as resolveConfigOptions } from "@richardgill/pi-config";

export type RegexPatternConfig = {
  regex: string;
  flags?: string;
};

type BashArgvConfig = {
  valueOptions?: string[];
  namedValueOptions?: Record<string, string>;
  stopAtDoubleDash?: boolean;
};

type PathCaptureRule =
  | { from: "positionals" }
  | { from: "positionalsAfter"; arg: string }
  | { from: "lastPositional" };

type CaptureValueRule = { from: "arg"; arg: string };

type RangeCaptureRule =
  | { from: "sedPrintScript"; arg: string }
  | { from: "headLineCount"; option: string }
  | { from: "tailLineCount"; option: string };

export type BashShimCommand = {
  name: string;
  argv?: BashArgvConfig;
  capture: {
    paths: PathCaptureRule;
    matchedText?: CaptureValueRule;
    range?: RangeCaptureRule;
  };
};

export type FileCollectorOptions = {
  filenameSuffix?: string;
  collectReadTool?: boolean;
  collectWriteTool?: boolean;
  collectEditTool?: boolean;
  collectBashCommand?: boolean;
  collectBashOutput?: boolean;
  collectAssistantOutput?: boolean;
  appendSystemPrompt?: string;
  assistantCitationPatterns?: RegexPatternConfig[];
  bashOutputPatterns?: RegexPatternConfig[];
  bashShimCommands?: BashShimCommand[];
};

type ResolvedOptions = Required<
  Pick<
    FileCollectorOptions,
    | "filenameSuffix"
    | "collectReadTool"
    | "collectWriteTool"
    | "collectEditTool"
    | "collectBashCommand"
    | "collectBashOutput"
    | "collectAssistantOutput"
    | "appendSystemPrompt"
    | "assistantCitationPatterns"
    | "bashOutputPatterns"
    | "bashShimCommands"
  >
>;

export type FileLineEventSource =
  | "read_tool"
  | "write_tool"
  | "edit_tool"
  | "bash_command"
  | "bash_output"
  | "assistant_output";

export type FileLineEvent = {
  source: FileLineEventSource;
  path: string;
  absolutePath: string;
  startLine?: number;
  endLine?: number;
  timestamp: string;
  display: string;
  detail?: string;
  previewTitle: string;
  toolCallId?: string;
  command?: string;
  rawCommand?: string;
  matchedText?: string;
};

type FileReference = {
  path: string;
  startLine?: number;
  endLine?: number;
  matchedText?: string;
};

type BashShimRecord = {
  command?: string;
  path?: string;
  startLine?: unknown;
  endLine?: unknown;
  matchedText?: string;
  timestamp?: string;
};

type EventMetadata = Partial<
  Pick<FileLineEvent, "toolCallId" | "command" | "rawCommand" | "timestamp">
>;

const BASH_SHIM_PARSER_PATH = fileURLToPath(new URL("./bash-shim-parser.cjs", import.meta.url));

const DEFAULT_ASSISTANT_CITATION_PATTERNS: RegexPatternConfig[] = [
  // Example: ./src/file.ts#L12 or ./src/file.ts#L12-L20
  {
    regex: String.raw`(?:^|[\s\`"'(<\[])(?<path>[^\s\`"'<>)]*?)#L(?<start>\d+)(?:-L?(?<end>\d+))?(?=$|[\s\`"'<>),;.\]])`,
    flags: "g",
  },
  // Example: ./src/file.ts:12 or ./src/file.ts:12-20
  {
    regex: String.raw`(?:^|[\s\`"'(<\[])(?<path>[^\s\`"'<>)]*?):(?<start>\d+)(?:-(?<end>\d+))?(?=$|[\s\`"'<>),;.\]])`,
    flags: "g",
  },
];

const DEFAULT_BASH_OUTPUT_PATTERNS: RegexPatternConfig[] = [
  // Example: ./src/file.ts:12:<matched text>
  {
    regex: String.raw`^(?<path>.+?):(?<start>\d+):(?<matchedText>.*)$`,
    flags: "gm",
  },
];

const DEFAULT_BASH_SHIM_COMMANDS: BashShimCommand[] = [
  {
    name: "cat",
    capture: { paths: { from: "positionals" } },
  },
  {
    name: "sed",
    capture: {
      paths: { from: "positionalsAfter", arg: "script" },
      matchedText: { from: "arg", arg: "script" },
      range: { from: "sedPrintScript", arg: "script" },
    },
  },
  {
    name: "head",
    argv: { valueOptions: ["-n", "--lines"] },
    capture: {
      paths: { from: "lastPositional" },
      range: { from: "headLineCount", option: "-n" },
    },
  },
  {
    name: "tail",
    argv: { valueOptions: ["-n", "--lines"] },
    capture: {
      paths: { from: "lastPositional" },
      range: { from: "tailLineCount", option: "-n" },
    },
  },
];

export const DEFAULT_OPTIONS: ResolvedOptions = {
  filenameSuffix: "file-line-events.jsonl",
  collectReadTool: true,
  collectWriteTool: true,
  collectEditTool: true,
  collectBashCommand: true,
  collectBashOutput: true,
  collectAssistantOutput: true,
  appendSystemPrompt: "",
  assistantCitationPatterns: DEFAULT_ASSISTANT_CITATION_PATTERNS,
  bashOutputPatterns: DEFAULT_BASH_OUTPUT_PATTERNS,
  bashShimCommands: DEFAULT_BASH_SHIM_COMMANDS,
};

const validateRegexPatterns = (patterns: RegexPatternConfig[]): void => {
  for (const pattern of patterns) {
    new RegExp(pattern.regex, pattern.flags);
  }
};

const validateBashCommandNames = (commands: Array<Pick<BashShimCommand, "name">>): void => {
  for (const command of commands) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(command.name)) {
      throw new Error(`Invalid bash shim command name: ${command.name}`);
    }
  }
};

export const resolveOptions = (options: FileCollectorOptions = {}): ResolvedOptions => {
  const resolvedConfig = resolveConfigOptions<ResolvedOptions>(DEFAULT_OPTIONS, options);
  validateRegexPatterns([
    ...resolvedConfig.assistantCitationPatterns,
    ...resolvedConfig.bashOutputPatterns,
  ]);
  validateBashCommandNames(resolvedConfig.bashShimCommands);
  return resolvedConfig;
};

const toPositiveLine = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return undefined;
  }

  return Math.floor(value);
};

const normalizeLineRange = (
  startLine?: number,
  endLine?: number,
): Pick<FileLineEvent, "startLine" | "endLine"> => {
  if (!startLine) {
    return {};
  }

  const end = endLine && endLine >= startLine ? endLine : startLine;
  return { startLine, endLine: end };
};

const expandHome = (targetPath: string): string => {
  if (targetPath === "~") {
    return os.homedir();
  }

  return targetPath.startsWith(`~${path.sep}`)
    ? path.join(os.homedir(), targetPath.slice(2))
    : targetPath;
};

export const resolveAbsolutePath = (targetPath: string, cwd: string): string => {
  const expanded = expandHome(targetPath);
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  const normalized = path.normalize(resolved);

  try {
    return realpathSync.native(normalized);
  } catch {
    return normalized;
  }
};

const isExistingFileReference = (targetPath: string, cwd: string): boolean => {
  try {
    return statSync(resolveAbsolutePath(targetPath, cwd)).isFile();
  } catch {
    return false;
  }
};

const formatRange = (pathValue: string, startLine?: number, endLine?: number): string => {
  if (!startLine) return pathValue;
  if (!endLine || endLine === startLine) return `${pathValue}:${startLine}`;
  return `${pathValue}:${startLine}-${endLine}`;
};

const formatMatchedText = (matchedText: string): string => {
  const normalized = matchedText.trim().replace(/\s+/g, " ");
  const preview = normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
  return JSON.stringify(preview);
};

const getFileLineEventDisplayLabel = (
  event: Pick<FileLineEvent, "source"> & Partial<Pick<FileLineEvent, "command">>,
): string => {
  if (event.source === "read_tool") return "read";
  if (event.source === "write_tool") return "write";
  if (event.source === "edit_tool") return "edited";
  if (event.source === "assistant_output") return "cited";
  return event.command ? `bash ${event.command}` : "bash output";
};

const getFileLineEventDetail = (
  event: Partial<Pick<FileLineEvent, "matchedText" | "detail">>,
): string | undefined => event.detail ?? event.matchedText;

const formatDisplayDetail = (detail?: string): string =>
  detail ? ` — ${formatMatchedText(detail)}` : "";

export const formatFileLineEventDisplay = (
  event: Pick<FileLineEvent, "source" | "path" | "startLine" | "endLine"> &
    Partial<Pick<FileLineEvent, "command" | "detail" | "matchedText">>,
): string => {
  const file = formatRange(event.path, event.startLine, event.endLine);
  const label = getFileLineEventDisplayLabel(event);
  const detail = getFileLineEventDetail(event);
  return `${label} ${file}${formatDisplayDetail(detail)}`;
};

const createFileLineEvent = (
  source: FileLineEventSource,
  reference: FileReference,
  ctx: ExtensionContext,
  metadata: EventMetadata = {},
): FileLineEvent => {
  const event = {
    source,
    path: reference.path,
    absolutePath: resolveAbsolutePath(reference.path, ctx.cwd),
    ...normalizeLineRange(reference.startLine, reference.endLine),
    timestamp: new Date().toISOString(),
    ...metadata,
    ...(reference.matchedText ? { matchedText: reference.matchedText } : {}),
  };
  const detail = getFileLineEventDetail(event);
  const display = formatFileLineEventDisplay({ ...event, detail });

  return {
    ...event,
    ...(detail ? { detail } : {}),
    display,
    previewTitle: display,
  };
};

export const createSessionSidecarPath = (sessionFile: string, filenameSuffix: string): string => {
  const parsed = path.parse(sessionFile);
  return path.join(parsed.dir, `${parsed.name}-${filenameSuffix}`);
};

const getSidecarPath = (ctx: ExtensionContext, options: ResolvedOptions): string | undefined => {
  const sessionFile = ctx.sessionManager.getSessionFile();
  return sessionFile ? createSessionSidecarPath(sessionFile, options.filenameSuffix) : undefined;
};

const writeSidecarEvent = async (
  sidecarPath: string | undefined,
  record: FileLineEvent,
): Promise<void> => {
  if (!sidecarPath) {
    return;
  }

  try {
    await mkdir(path.dirname(sidecarPath), { recursive: true });
    await appendFile(sidecarPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {}
};

const appendRecordEvent = async (
  sidecarPath: string | undefined,
  record: FileLineEvent,
): Promise<void> => {
  await writeSidecarEvent(sidecarPath, record);
};

const recordEvent = async (
  ctx: ExtensionContext,
  record: FileLineEvent,
  options: ResolvedOptions,
): Promise<void> => {
  const sidecarPath = getSidecarPath(ctx, options);
  await appendRecordEvent(sidecarPath, record);
};

const recordEvents = async (
  ctx: ExtensionContext,
  records: FileLineEvent[],
  options: ResolvedOptions,
): Promise<void> => {
  const sidecarPath = getSidecarPath(ctx, options);
  for (const record of records) {
    await appendRecordEvent(sidecarPath, record);
  }
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
      if (!part || typeof part !== "object") {
        return "";
      }

      const block = part as { text?: unknown };
      return typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
};

const parseLineRange = (
  start?: string,
  end?: string,
): Pick<FileReference, "startLine" | "endLine"> => {
  const startLine = Number.parseInt(start ?? "", 10);
  const endLine = end ? Number.parseInt(end, 10) : startLine;

  if (!Number.isFinite(startLine) || startLine < 1) {
    return {};
  }

  return {
    startLine,
    endLine: Number.isFinite(endLine) && endLine >= startLine ? endLine : startLine,
  };
};

const hasInvalidPathCharacters = (value: string): boolean =>
  value.includes("{") ||
  value.includes("}") ||
  value.includes('"') ||
  Array.from(value).some((char) => char.charCodeAt(0) < 32);

const isPathLike = (value: string): boolean =>
  !hasInvalidPathCharacters(value) &&
  (value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.includes("/") ||
    /\.[A-Za-z0-9_-]+$/.test(value));

const cleanPathCandidate = (value: string): string =>
  value.replace(/^[@`"'<([]+/, "").replace(/[`"'>)\],;.]+$/, "");

const compilePattern = (pattern: RegexPatternConfig): RegExp => {
  const flags = pattern.flags?.includes("g") ? pattern.flags : `${pattern.flags ?? ""}g`;
  return new RegExp(pattern.regex, flags);
};

const extractReferencesFromPatterns = (
  text: string,
  patterns: RegexPatternConfig[],
): FileReference[] => {
  const refs: { index: number; reference: FileReference }[] = [];

  for (const pattern of patterns) {
    const regex = compilePattern(pattern);
    for (const match of text.matchAll(regex)) {
      const groups = match.groups ?? {};
      const targetPath = cleanPathCandidate(groups.path ?? match[1] ?? "");
      if (targetPath && isPathLike(targetPath)) {
        refs.push({
          index: match.index ?? 0,
          reference: {
            path: targetPath,
            ...parseLineRange(groups.start ?? match[2], groups.end ?? match[3]),
            ...(groups.matchedText ? { matchedText: groups.matchedText } : {}),
          },
        });
      }
    }
  }

  return refs.sort((a, b) => a.index - b.index).map((ref) => ref.reference);
};

export const extractAssistantReferences = (
  text: string,
  patterns: RegexPatternConfig[] = DEFAULT_ASSISTANT_CITATION_PATTERNS,
): FileReference[] => extractReferencesFromPatterns(text, patterns);

export const extractBashOutputReferences = (
  text: string,
  patterns: RegexPatternConfig[] = DEFAULT_BASH_OUTPUT_PATTERNS,
): FileReference[] => extractReferencesFromPatterns(text, patterns);

const countTextLines = (text: string): number => {
  if (!text) return 0;
  const lines = text.split(/\r\n|\r|\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
};

export const extractReadToolRange = (
  content: string,
  fallbackOffset: unknown,
  fallbackLimit: unknown,
) => {
  const showingMatch = content.match(/Showing lines (\d+)-(\d+)/);
  if (showingMatch) {
    return parseLineRange(showingMatch[1], showingMatch[2]);
  }

  const startLine = toPositiveLine(fallbackOffset) ?? 1;
  const limit = toPositiveLine(fallbackLimit);
  const contentLineCount = countTextLines(content);
  const endLine = limit ?? contentLineCount;
  return {
    startLine,
    ...(endLine ? { endLine: startLine + endLine - 1 } : {}),
  };
};

export const extractWriteToolRange = (content: string) => {
  const endLine = countTextLines(content);
  return { startLine: 1, ...(endLine ? { endLine } : {}) };
};

export const extractEditToolRange = (details: unknown) => {
  const firstChangedLine = (details as { firstChangedLine?: unknown } | undefined)
    ?.firstChangedLine;
  const startLine = toPositiveLine(firstChangedLine);
  return startLine ? { startLine } : {};
};

const buildReadToolEvent = (
  event: {
    input: Record<string, unknown>;
    content: unknown;
    toolCallId?: string;
  },
  ctx: ExtensionContext,
) => {
  const targetPath = event.input.path;
  if (typeof targetPath !== "string") {
    return undefined;
  }

  const text = extractTextContent(event.content);
  const range = extractReadToolRange(text, event.input.offset, event.input.limit);
  return createFileLineEvent("read_tool", { path: targetPath, ...range }, ctx, {
    toolCallId: event.toolCallId,
  });
};

const buildWriteToolEvent = (
  event: { input: Record<string, unknown>; toolCallId?: string },
  ctx: ExtensionContext,
) => {
  const targetPath = event.input.path;
  const content = event.input.content;
  if (typeof targetPath !== "string" || typeof content !== "string") {
    return undefined;
  }

  return createFileLineEvent(
    "write_tool",
    { path: targetPath, ...extractWriteToolRange(content) },
    ctx,
    { toolCallId: event.toolCallId },
  );
};

const buildEditToolEvent = (
  event: {
    input: Record<string, unknown>;
    details: unknown;
    toolCallId?: string;
  },
  ctx: ExtensionContext,
) => {
  const targetPath = event.input.path;
  if (typeof targetPath !== "string") {
    return undefined;
  }

  return createFileLineEvent(
    "edit_tool",
    { path: targetPath, ...extractEditToolRange(event.details) },
    ctx,
    { toolCallId: event.toolCallId },
  );
};

const createReferenceEvents = (
  source: FileLineEventSource,
  references: FileReference[],
  ctx: ExtensionContext,
  metadata: EventMetadata = {},
  { requireExistingFile = false }: { requireExistingFile?: boolean } = {},
): FileLineEvent[] =>
  references
    .filter((reference) => !requireExistingFile || isExistingFileReference(reference.path, ctx.cwd))
    .map((reference) => createFileLineEvent(source, reference, ctx, metadata));

const createBashShimPath = (toolCallId: string): string =>
  path.join(os.tmpdir(), `pi-file-line-tracker-${process.pid}-${toolCallId}.jsonl`);

const getExecutableName = (rawCommand: string | undefined): string | undefined => {
  const executable = rawCommand?.trim().match(/^([^\s;&|]+)/)?.[1];
  return executable ? path.basename(executable) : undefined;
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const buildBashShimFunction = (command: BashShimCommand): string => `${command.name}() {
  node ${shellQuote(BASH_SHIM_PARSER_PATH)} "$__PI_FILE_LINE_TRACKER_EVENTS" ${shellQuote(command.name)} ${shellQuote(JSON.stringify(command))} "$@"
  command ${command.name} "$@"
}`;

const buildBashCommandWithShim = (
  command: string,
  shimPath: string,
  options: ResolvedOptions,
): string => {
  const shims = options.bashShimCommands.map(buildBashShimFunction).join("\n\n");
  return `export __PI_FILE_LINE_TRACKER_EVENTS=${shellQuote(shimPath)}\n${shims}\n${command}`;
};

const readBashShimRecords = async (shimPath: string): Promise<BashShimRecord[]> => {
  try {
    const content = await readFile(shimPath, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BashShimRecord);
  } catch {
    return [];
  } finally {
    await rm(shimPath, { force: true });
  }
};

const buildBashCommandEvents = (
  records: BashShimRecord[],
  ctx: ExtensionContext,
  toolCallId: string,
  fallbackCommand: string,
): FileLineEvent[] =>
  records.flatMap((record) => {
    if (typeof record.path !== "string" || !record.path) {
      return [];
    }

    if (!isExistingFileReference(record.path, ctx.cwd)) {
      return [];
    }

    const reference: FileReference = {
      path: record.path,
      startLine: toPositiveLine(record.startLine),
      endLine: toPositiveLine(record.endLine),
      ...(record.matchedText ? { matchedText: record.matchedText } : {}),
    };

    return [
      createFileLineEvent("bash_command", reference, ctx, {
        toolCallId,
        command: record.command ?? getExecutableName(fallbackCommand),
        rawCommand: fallbackCommand,
        timestamp: record.timestamp,
      }),
    ];
  });

const registerSystemPromptAppender = (options: ResolvedOptions, pi: ExtensionAPI): void => {
  const append = options.appendSystemPrompt.trim();
  if (!append) {
    return;
  }

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${append}`,
  }));
};

const registerCollectors = (options: ResolvedOptions, pi: ExtensionAPI): void => {
  const bashShimPaths = new Map<string, { path: string; command: string }>();

  pi.on("tool_call", async (event) => {
    if (!options.collectBashCommand || !isToolCallEventType("bash", event)) {
      return;
    }

    const shimPath = createBashShimPath(event.toolCallId);
    bashShimPaths.set(event.toolCallId, {
      path: shimPath,
      command: event.input.command,
    });
    event.input.command = buildBashCommandWithShim(event.input.command, shimPath, options);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (options.collectReadTool && isReadToolResult(event) && !event.isError) {
      const record = buildReadToolEvent(event, ctx);
      if (record) {
        await recordEvent(ctx, record, options);
      }
      return;
    }

    if (options.collectWriteTool && isWriteToolResult(event) && !event.isError) {
      const record = buildWriteToolEvent(event, ctx);
      if (record) {
        await recordEvent(ctx, record, options);
      }
      return;
    }

    if (options.collectEditTool && isEditToolResult(event) && !event.isError) {
      const record = buildEditToolEvent(event, ctx);
      if (record) {
        await recordEvent(ctx, record, options);
      }
      return;
    }

    if (!isBashToolResult(event)) {
      return;
    }

    const shim = bashShimPaths.get(event.toolCallId);
    bashShimPaths.delete(event.toolCallId);

    const bashShimRecords =
      options.collectBashCommand && shim ? await readBashShimRecords(shim.path) : [];

    if (options.collectBashCommand && shim) {
      const commandEvents = buildBashCommandEvents(
        bashShimRecords,
        ctx,
        event.toolCallId,
        shim.command,
      );
      await recordEvents(ctx, commandEvents, options);
    }

    if (options.collectBashOutput && !event.isError) {
      const references = extractBashOutputReferences(
        extractTextContent(event.content),
        options.bashOutputPatterns,
      );
      await recordEvents(
        ctx,
        createReferenceEvents(
          "bash_output",
          references,
          ctx,
          {
            toolCallId: event.toolCallId,
            rawCommand: shim?.command,
          },
          { requireExistingFile: true },
        ),
        options,
      );
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (!options.collectAssistantOutput) {
      return;
    }

    const message = event.message as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") {
      return;
    }

    const references = extractAssistantReferences(
      extractTextContent(message.content),
      options.assistantCitationPatterns,
    );
    await recordEvents(ctx, createReferenceEvents("assistant_output", references, ctx), options);
  });
};

export const fileCollector = (input: FileCollectorOptions = {}) => {
  const options = resolveOptions(input);

  return (pi: ExtensionAPI): void => {
    registerSystemPromptAppender(options, pi);
    registerCollectors(options, pi);
  };
};

export const extension = (input: FileCollectorOptions = {}) => fileCollector(input);
