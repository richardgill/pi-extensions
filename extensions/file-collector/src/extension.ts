import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isBashToolResult,
  isReadToolResult,
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@mariozechner/pi-coding-agent";

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
  commandName?: string;
  sidecarEnabled?: boolean;
  sidecarFilename?: string;
  collectReadTool?: boolean;
  collectBashCommand?: boolean;
  collectBashOutput?: boolean;
  collectAssistantOutput?: boolean;
  assistantCitationPatterns?: RegexPatternConfig[];
  bashOutputPatterns?: RegexPatternConfig[];
  bashShimCommands?: BashShimCommand[];
};

type ResolvedOptions = Required<
  Pick<
    FileCollectorOptions,
    | "commandName"
    | "sidecarEnabled"
    | "sidecarFilename"
    | "collectReadTool"
    | "collectBashCommand"
    | "collectBashOutput"
    | "collectAssistantOutput"
    | "assistantCitationPatterns"
    | "bashOutputPatterns"
    | "bashShimCommands"
  >
>;

export type FileLineEventSource = "read_tool" | "bash_command" | "bash_output" | "assistant_output";

export type FileLineEvent = {
  source: FileLineEventSource;
  path: string;
  absolutePath: string;
  startLine?: number;
  endLine?: number;
  timestamp: string;
  toolCallId?: string;
  command?: string;
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
};

type SourceCounts = Record<FileLineEventSource, number>;

const CUSTOM_TYPE = "file-line-event";

const DEFAULT_ASSISTANT_CITATION_PATTERNS: RegexPatternConfig[] = [
  {
    regex: String.raw`(?:^|[\s\`"'(<\[])(?<path>[^\s\`"'<>)]*?)#L(?<start>\d+)(?:-L?(?<end>\d+))?(?=$|[\s\`"'<>),;\]])`,
    flags: "g",
  },
  {
    regex: String.raw`(?:^|[\s\`"'(<\[])(?<path>[^\s\`"'<>)]*?):(?<start>\d+)(?:-(?<end>\d+))?(?=$|[\s\`"'<>),;\]])`,
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
    name: "grep",
    argv: {
      valueOptions: ["-f"],
      namedValueOptions: { "-e": "pattern" },
    },
    capture: {
      paths: { from: "positionalsAfter", arg: "pattern" },
      matchedText: { from: "arg", arg: "pattern" },
    },
  },
  {
    name: "rg",
    argv: {
      valueOptions: ["-g", "--glob", "-t", "--type"],
      namedValueOptions: { "-e": "pattern" },
    },
    capture: {
      paths: { from: "positionalsAfter", arg: "pattern" },
      matchedText: { from: "arg", arg: "pattern" },
    },
  },
];

const DEFAULT_OPTIONS: ResolvedOptions = {
  commandName: "file-collector",
  sidecarEnabled: true,
  sidecarFilename: "file-line-events.jsonl",
  collectReadTool: true,
  collectBashCommand: true,
  collectBashOutput: true,
  collectAssistantOutput: true,
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
const findLineCountRange = (option) => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const direct = arg === option ? toNumber(next) : undefined;
    const joined = arg.startsWith(option) ? toNumber(arg.slice(option.length)) : undefined;
    const endLine = direct || joined;
    if (endLine) return { startLine: 1, endLine };
  }
  return {};
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
const captureRange = () => {
  const rule = spec.capture.range;
  if (!rule) return {};
  if (rule.from === "sedPrintScript") return parseSedRange(ensureArg(rule.arg));
  if (rule.from === "headLineCount") return findLineCountRange(rule.option);
  return {};
};
const matchedText = captureMatchedText();
const range = captureRange();
for (const target of capturePaths()) {
  if (target && target !== "-") {
    fs.appendFileSync(file, JSON.stringify({ command, path: target, matchedText, ...range }) + "\n");
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

const validateBashShimCommands = (commands: BashShimCommand[]): void => {
  for (const command of commands) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(command.name)) {
      throw new Error(`Invalid bash shim command name: ${command.name}`);
    }
  }
};

export const resolveOptions = (options: FileCollectorOptions = {}): ResolvedOptions => {
  const resolved = {
    commandName: options.commandName ?? DEFAULT_OPTIONS.commandName,
    sidecarEnabled: options.sidecarEnabled ?? DEFAULT_OPTIONS.sidecarEnabled,
    sidecarFilename: options.sidecarFilename ?? DEFAULT_OPTIONS.sidecarFilename,
    collectReadTool: options.collectReadTool ?? DEFAULT_OPTIONS.collectReadTool,
    collectBashCommand: options.collectBashCommand ?? DEFAULT_OPTIONS.collectBashCommand,
    collectBashOutput: options.collectBashOutput ?? DEFAULT_OPTIONS.collectBashOutput,
    collectAssistantOutput:
      options.collectAssistantOutput ?? DEFAULT_OPTIONS.collectAssistantOutput,
    assistantCitationPatterns: clonePatternConfigs(
      options.assistantCitationPatterns ?? DEFAULT_OPTIONS.assistantCitationPatterns,
    ),
    bashOutputPatterns: clonePatternConfigs(
      options.bashOutputPatterns ?? DEFAULT_OPTIONS.bashOutputPatterns,
    ),
    bashShimCommands: cloneBashShimCommands(
      options.bashShimCommands ?? DEFAULT_OPTIONS.bashShimCommands,
    ),
  };

  validateRegexPatterns([...resolved.assistantCitationPatterns, ...resolved.bashOutputPatterns]);
  validateBashShimCommands(resolved.bashShimCommands);
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

const createFileLineEvent = (
  source: FileLineEventSource,
  reference: FileReference,
  ctx: ExtensionContext,
  metadata: Pick<FileLineEvent, "toolCallId" | "command"> = {},
): FileLineEvent => ({
  source,
  path: reference.path,
  absolutePath: resolveAbsolutePath(reference.path, ctx.cwd),
  ...normalizeLineRange(reference.startLine, reference.endLine),
  timestamp: new Date().toISOString(),
  ...metadata,
  ...(reference.matchedText ? { matchedText: reference.matchedText } : {}),
});

const getSidecarPath = (ctx: ExtensionContext, options: ResolvedOptions): string | undefined => {
  const sessionFile = ctx.sessionManager.getSessionFile();
  return sessionFile && options.sidecarEnabled
    ? path.join(path.dirname(sessionFile), options.sidecarFilename)
    : undefined;
};

const writeSidecarEvent = async (
  ctx: ExtensionContext,
  record: FileLineEvent,
  options: ResolvedOptions,
): Promise<void> => {
  const sidecarPath = getSidecarPath(ctx, options);
  if (!sidecarPath) {
    return;
  }

  try {
    await mkdir(path.dirname(sidecarPath), { recursive: true });
    await appendFile(sidecarPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {}
};

const recordEvent = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: FileLineEvent,
  options: ResolvedOptions,
): Promise<void> => {
  pi.appendEntry<FileLineEvent>(CUSTOM_TYPE, record);
  await writeSidecarEvent(ctx, record, options);
};

const recordEvents = async (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  records: FileLineEvent[],
  options: ResolvedOptions,
): Promise<void> => {
  for (const record of records) {
    await recordEvent(pi, ctx, record, options);
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

const isPathLike = (value: string): boolean =>
  value.startsWith("./") ||
  value.startsWith("../") ||
  value.startsWith("/") ||
  value.startsWith("~/") ||
  value.includes("/") ||
  /\.[A-Za-z0-9_-]+$/.test(value);

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

const extractReadToolRange = (content: string, fallbackOffset: unknown, fallbackLimit: unknown) => {
  const showingMatch = content.match(/Showing lines (\d+)-(\d+)/);
  if (showingMatch) {
    return parseLineRange(showingMatch[1], showingMatch[2]);
  }

  const startLine = toPositiveLine(fallbackOffset) ?? 1;
  const limit = toPositiveLine(fallbackLimit);
  return { startLine, ...(limit ? { endLine: startLine + limit - 1 } : {}) };
};

const buildReadToolEvent = (
  event: { input: Record<string, unknown>; content: unknown },
  ctx: ExtensionContext,
) => {
  const targetPath = event.input.path;
  if (typeof targetPath !== "string") {
    return undefined;
  }

  const text = extractTextContent(event.content);
  const range = extractReadToolRange(text, event.input.offset, event.input.limit);
  return createFileLineEvent("read_tool", { path: targetPath, ...range }, ctx);
};

const createReferenceEvents = (
  source: FileLineEventSource,
  references: FileReference[],
  ctx: ExtensionContext,
  metadata: Pick<FileLineEvent, "toolCallId" | "command"> = {},
): FileLineEvent[] =>
  references.map((reference) => createFileLineEvent(source, reference, ctx, metadata));

const createBashShimPath = (toolCallId: string): string =>
  path.join(os.tmpdir(), `pi-file-line-tracker-${process.pid}-${toolCallId}.jsonl`);

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

const buildBashCommandEvents = async (
  shimPath: string,
  ctx: ExtensionContext,
  toolCallId: string,
  fallbackCommand: string,
): Promise<FileLineEvent[]> => {
  const records = await readBashShimRecords(shimPath);
  return records.flatMap((record) => {
    if (typeof record.path !== "string" || !record.path) {
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
        command: record.command ?? fallbackCommand,
      }),
    ];
  });
};

const isFileLineEvent = (data: unknown): data is FileLineEvent => {
  if (!data || typeof data !== "object") {
    return false;
  }

  const record = data as Record<string, unknown>;
  return (
    typeof record.source === "string" &&
    typeof record.path === "string" &&
    typeof record.absolutePath === "string" &&
    typeof record.timestamp === "string"
  );
};

const getBranchFileLineEvents = (entries: SessionEntry[]): FileLineEvent[] =>
  entries.flatMap((entry) => {
    if (
      entry.type !== "custom" ||
      entry.customType !== CUSTOM_TYPE ||
      !isFileLineEvent(entry.data)
    ) {
      return [];
    }

    return [entry.data];
  });

const summarizeEvents = (events: FileLineEvent[]): string => {
  const counts: SourceCounts = {
    read_tool: 0,
    bash_command: 0,
    bash_output: 0,
    assistant_output: 0,
  };

  for (const event of events) {
    counts[event.source] += 1;
  }

  return [
    `${events.length} file-line events`,
    `seen: ${counts.read_tool + counts.bash_command + counts.bash_output}`,
    `cited: ${counts.assistant_output}`,
    `read_tool: ${counts.read_tool}`,
    `bash_command: ${counts.bash_command}`,
    `bash_output: ${counts.bash_output}`,
  ].join(" • ");
};

const registerCommand = (options: ResolvedOptions, pi: ExtensionAPI): void => {
  pi.registerCommand(options.commandName, {
    description: "Show collected file/line evidence for this session branch",
    handler: async (_args, ctx) => {
      const events = getBranchFileLineEvents(ctx.sessionManager.getBranch());
      ctx.ui.notify(summarizeEvents(events), "info");
    },
  });
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
        await recordEvent(pi, ctx, record, options);
      }
      return;
    }

    if (!isBashToolResult(event)) {
      return;
    }

    const shim = bashShimPaths.get(event.toolCallId);
    bashShimPaths.delete(event.toolCallId);

    if (options.collectBashCommand && shim) {
      const commandEvents = await buildBashCommandEvents(
        shim.path,
        ctx,
        event.toolCallId,
        shim.command,
      );
      await recordEvents(pi, ctx, commandEvents, options);
    }

    if (options.collectBashOutput && !event.isError) {
      const references = extractBashOutputReferences(
        extractTextContent(event.content),
        options.bashOutputPatterns,
      );
      await recordEvents(
        pi,
        ctx,
        createReferenceEvents("bash_output", references, ctx, {
          toolCallId: event.toolCallId,
          command: shim?.command,
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
    await recordEvents(
      pi,
      ctx,
      createReferenceEvents("assistant_output", references, ctx),
      options,
    );
  });
};

export const fileCollector = (input: FileCollectorOptions = {}) => {
  const options = resolveOptions(input);

  return (pi: ExtensionAPI): void => {
    registerCommand(options, pi);
    registerCollectors(options, pi);
  };
};

export const extension = (input: FileCollectorOptions = {}) => fileCollector(input);
