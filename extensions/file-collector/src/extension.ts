import { realpathSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  sidecarFilename?: string;
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
    | "sidecarFilename"
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

export type FileLineEventKind = "read" | "write" | "edit" | "bash" | "assistant_citation";

export type FileLineEvent = {
  source: FileLineEventSource;
  kind: FileLineEventKind;
  action: string;
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

const DEFAULT_ASSISTANT_CITATION_PATTERNS: RegexPatternConfig[] = [
  {
    regex: String.raw`(?:^|[\s\`"'(<\[])(?<path>[^\s\`"'<>)]*?)#L(?<start>\d+)(?:-L?(?<end>\d+))?(?=$|[\s\`"'<>),;.\]])`,
    flags: "g",
  },
  {
    regex: String.raw`(?:^|[\s\`"'(<\[])(?<path>[^\s\`"'<>)]*?):(?<start>\d+)(?:-(?<end>\d+))?(?=$|[\s\`"'<>),;.\]])`,
    flags: "g",
  },
];

const DEFAULT_BASH_OUTPUT_PATTERNS: RegexPatternConfig[] = [
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
  sidecarFilename: "file-line-events.jsonl",
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

const BASH_SHIM_RUNTIME = String.raw`
__pi_file_line_tracker_parse() {
  local __pi_file_line_tracker_command="$1"
  local __pi_file_line_tracker_spec="$2"
  shift 2
  node - "$__PI_FILE_LINE_TRACKER_EVENTS" "$__pi_file_line_tracker_command" "$__pi_file_line_tracker_spec" "$@" <<'__PI_FILE_LINE_TRACKER_NODE__'
const fs = require("node:fs");
const [file, command, specJson, ...argv] = process.argv.slice(2);
const spec = JSON.parse(specJson);
const toNumber = (value) => /^\d+$/.test(String(value || "")) ? Number(value) : undefined;
const optionParts = (arg) => {
  const index = arg.indexOf("=");
  return index > 0 ? { name: arg.slice(0, index), value: arg.slice(index + 1) } : { name: arg };
};
const parseSedRange = (script) => {
  const range = String(script || "").match(/^(\d+)(?:,(\d+))?p/);
  if (!range) return {};
  const startLine = toNumber(range[1]);
  const endLine = toNumber(range[2]) || startLine;
  return startLine ? { startLine, endLine } : {};
};
const findLineCount = (option) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const direct = arg === option ? toNumber(next) : undefined;
    const joined = arg.startsWith(option) ? toNumber(arg.slice(option.length)) : undefined;
    const count = direct || joined;
    if (count) return count;
  }
  return undefined;
};
const countFileLines = (target) => {
  try {
    const content = fs.readFileSync(target, "utf8");
    if (!content) return 0;
    const lines = content.split(/\r\n|\r|\n/);
    return lines.at(-1) === "" ? lines.length - 1 : lines.length;
  } catch {
    return undefined;
  }
};
const isExistingFileTarget = (target) => {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
};
const collectPositionals = () => {
  const valueOptions = new Set(spec.argv?.valueOptions || []);
  const namedValueOptions = spec.argv?.namedValueOptions || {};
  const stopAtDoubleDash = spec.argv?.stopAtDoubleDash !== false;
  const namedArgs = {};
  const namedIndexes = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (stopAtDoubleDash && arg === "--") {
      positionals.push(...argv.slice(index + 1));
      index = argv.length;
    } else if (arg.startsWith("-") && arg !== "-") {
      const option = optionParts(arg);
      const namedArg = namedValueOptions[option.name];
      if (namedArg) {
        const value = option.value === undefined ? argv[index + 1] : option.value;
        if (value !== undefined) namedArgs[namedArg] = value;
        if (option.value === undefined) index += 1;
      } else if (valueOptions.has(option.name) && option.value === undefined) {
        index += 1;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, namedArgs, namedIndexes };
};
const parsed = collectPositionals();
const ensureArg = (argName) => {
  if (parsed.namedArgs[argName] !== undefined) return parsed.namedArgs[argName];
  const first = parsed.positionals[0];
  if (first !== undefined) {
    parsed.namedArgs[argName] = first;
    parsed.namedIndexes[argName] = 0;
  }
  return first;
};
const capturePaths = () => {
  const rule = spec.capture.paths;
  if (rule.from === "positionals") return parsed.positionals;
  if (rule.from === "lastPositional") return parsed.positionals.slice(-1);
  const argValue = ensureArg(rule.arg);
  const index = parsed.namedIndexes[rule.arg];
  return argValue !== undefined && index !== undefined
    ? parsed.positionals.slice(index + 1)
    : parsed.positionals;
};
const captureMatchedText = () => {
  const rule = spec.capture.matchedText;
  return rule?.from === "arg" ? ensureArg(rule.arg) : undefined;
};
const captureRange = (target) => {
  const rule = spec.capture.range;
  if (!rule) return {};
  if (rule.from === "sedPrintScript") return parseSedRange(ensureArg(rule.arg));
  if (rule.from === "headLineCount") {
    const endLine = findLineCount(rule.option);
    return endLine ? { startLine: 1, endLine } : {};
  }
  if (rule.from === "tailLineCount") {
    const count = findLineCount(rule.option);
    const total = countFileLines(target);
    if (!count || !total) return {};
    return { startLine: Math.max(1, total - count + 1), endLine: total };
  }
  return {};
};
const matchedText = captureMatchedText();
for (const target of capturePaths()) {
  if (target && target !== "-" && isExistingFileTarget(target)) {
    const range = captureRange(target);
    fs.appendFileSync(file, JSON.stringify({ command, path: target, matchedText, timestamp: new Date().toISOString(), ...range }) + "\n");
  }
}
__PI_FILE_LINE_TRACKER_NODE__
}
`;

const clonePatternConfigs = (patterns: RegexPatternConfig[]): RegexPatternConfig[] =>
  patterns.map((pattern) => ({ ...pattern }));

const cloneBashShimCommands = (commands: BashShimCommand[]): BashShimCommand[] =>
  commands.map((command) => ({
    ...command,
    argv: command.argv
      ? {
          ...command.argv,
          valueOptions: command.argv.valueOptions ? [...command.argv.valueOptions] : undefined,
          namedValueOptions: command.argv.namedValueOptions
            ? { ...command.argv.namedValueOptions }
            : undefined,
        }
      : undefined,
    capture: { ...command.capture },
  }));

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
  const merged = resolveConfigOptions<ResolvedOptions>(DEFAULT_OPTIONS, options);
  const resolved = {
    ...merged,
    assistantCitationPatterns: clonePatternConfigs(merged.assistantCitationPatterns),
    bashOutputPatterns: clonePatternConfigs(merged.bashOutputPatterns),
    bashShimCommands: cloneBashShimCommands(merged.bashShimCommands),
  };

  validateRegexPatterns([...resolved.assistantCitationPatterns, ...resolved.bashOutputPatterns]);
  validateBashCommandNames(resolved.bashShimCommands);
  return resolved;
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

const getFileLineEventKind = (source: FileLineEventSource): FileLineEventKind => {
  if (source === "read_tool") return "read";
  if (source === "write_tool") return "write";
  if (source === "edit_tool") return "edit";
  if (source === "assistant_output") return "assistant_citation";
  return "bash";
};

const getFileLineEventAction = (
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
    Partial<Pick<FileLineEvent, "action" | "command" | "detail" | "matchedText">>,
): string => {
  const file = formatRange(event.path, event.startLine, event.endLine);
  const action = event.action ?? getFileLineEventAction(event);
  const detail = getFileLineEventDetail(event);
  return `${action} ${file}${formatDisplayDetail(detail)}`;
};

const createFileLineEvent = (
  source: FileLineEventSource,
  reference: FileReference,
  ctx: ExtensionContext,
  metadata: EventMetadata = {},
): FileLineEvent => {
  const event = {
    source,
    kind: getFileLineEventKind(source),
    path: reference.path,
    absolutePath: resolveAbsolutePath(reference.path, ctx.cwd),
    ...normalizeLineRange(reference.startLine, reference.endLine),
    timestamp: new Date().toISOString(),
    ...metadata,
    ...(reference.matchedText ? { matchedText: reference.matchedText } : {}),
  };
  const action = getFileLineEventAction(event);
  const detail = getFileLineEventDetail(event);
  const display = formatFileLineEventDisplay({ ...event, action, detail });

  return { ...event, action, ...(detail ? { detail } : {}), display, previewTitle: display };
};

export const createSessionSidecarPath = (sessionFile: string, sidecarFilename: string): string => {
  const parsed = path.parse(sessionFile);
  return path.join(parsed.dir, `${parsed.name}-${sidecarFilename}`);
};

const getSidecarPath = (ctx: ExtensionContext, options: ResolvedOptions): string | undefined => {
  const sessionFile = ctx.sessionManager.getSessionFile();
  return sessionFile ? createSessionSidecarPath(sessionFile, options.sidecarFilename) : undefined;
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
  return { startLine, ...(endLine ? { endLine: startLine + endLine - 1 } : {}) };
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
  event: { input: Record<string, unknown>; content: unknown; toolCallId?: string },
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
  event: { input: Record<string, unknown>; details: unknown; toolCallId?: string },
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
): FileLineEvent[] =>
  references
    .filter((reference) =>
      source === "bash_output" ? isExistingFileReference(reference.path, ctx.cwd) : true,
    )
    .map((reference) => createFileLineEvent(source, reference, ctx, metadata));

const createBashShimPath = (toolCallId: string): string =>
  path.join(os.tmpdir(), `pi-file-line-tracker-${process.pid}-${toolCallId}.jsonl`);

const getExecutableName = (rawCommand: string | undefined): string | undefined => {
  const executable = rawCommand?.trim().match(/^([^\s;&|]+)/)?.[1];
  return executable ? path.basename(executable) : undefined;
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const buildBashShimFunction = (command: BashShimCommand): string => `${command.name}() {
  __pi_file_line_tracker_parse ${shellQuote(command.name)} ${shellQuote(JSON.stringify(command))} "$@"
  command ${command.name} "$@"
}`;

const buildBashCommandWithShim = (
  command: string,
  shimPath: string,
  options: ResolvedOptions,
): string => {
  const shims = options.bashShimCommands.map(buildBashShimFunction).join("\n\n");
  return `export __PI_FILE_LINE_TRACKER_EVENTS=${shellQuote(shimPath)}\n${BASH_SHIM_RUNTIME}\n${shims}\n${command}`;
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

const createBashOutputEvents = (
  references: FileReference[],
  ctx: ExtensionContext,
  metadata: EventMetadata = {},
): FileLineEvent[] =>
  references
    .filter((reference) => isExistingFileReference(reference.path, ctx.cwd))
    .map((reference) => createFileLineEvent("bash_output", reference, ctx, metadata));

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
    bashShimPaths.set(event.toolCallId, { path: shimPath, command: event.input.command });
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
        createBashOutputEvents(references, ctx, {
          toolCallId: event.toolCallId,
          rawCommand: shim?.command,
        }),
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
