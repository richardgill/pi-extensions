import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import {
	discoverSkills,
	type ExtensionAPI,
	getMarkdownTheme,
	loadSettings,
	type Skill,
	type Theme,
	type ThemeColor,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type BuiltInToolName, getBuiltInToolsFromActiveTools, resolveTaskConfig } from "./task-config.js";
import {
	isRecord,
	MAX_PARALLEL_TASKS,
	normalizeTaskParams,
	type TaskThinking,
	type TaskWorkItem,
	VALID_THINKING_OPTIONS,
} from "./task-params.js";

export type PromptPatch = { match: RegExp; replace: string };

export type TaskToolOptions = {
	name: string;
	label: string;
	description: string;
	maxParallelTasks: number;
	maxConcurrency: number;
	collapsedItemCount: number;
	skillListLimit: number;
	systemPromptPatches: PromptPatch[];
};

const DEFAULT_OPTIONS: TaskToolOptions = {
	name: "task",
	label: "Task",
	description: [
		"Run isolated pi subprocess tasks (single, chain, or parallel).",
		"Supports optional skill wrapper (matches /skill: behavior) and optional model override (provider/modelId).",
	].join(" "),
	maxParallelTasks: MAX_PARALLEL_TASKS,
	maxConcurrency: 4,
	collapsedItemCount: 10,
	skillListLimit: 30,
	systemPromptPatches: [
		{
			match: /\n\s*\n\s*in addition to the tools above, you may have access to other custom tools depending on the project\./i,
			replace: "\n- task: Run isolated pi subprocess tasks (single, chain, or parallel).",
		},
		{
			match: /Use the read tool to load a skill's file when the task matches its description\./i,
			replace:
				"Use skill directly: Use the read tool to load a skill's file when the task matches its description. Use skill in task: Pass the skill to the task tool and the task context will load it.",
		},
	],
};

const applyPromptPatches = (prompt: string, patches: PromptPatch[]): string => {
	return patches.reduce((value, patch) => value.replace(patch.match, patch.replace), prompt);
};

type UsageStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
};

type SingleResult = {
	prompt: string;
	skill?: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking?: ThinkingLevel;
	stopReason?: string;
	errorMessage?: string;
	index?: number;
};

type TaskToolDetails = {
	mode: "single" | "parallel" | "chain";
	modelOverride?: string;
	results: SingleResult[];
};

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

type PreparedTask = {
	item: TaskWorkItem;
	subprocessPrompt: string;
};

type PreparedExecution = {
	task: PreparedTask;
	config: { thinkingLevel: ThinkingLevel; subprocessArgs: string[]; modelLabel: string | undefined };
};

const shortenPath = (filePath: string): string => {
	const home = os.homedir();
	return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
};

const formatTokens = (count: number): string => {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
};

const formatUsageStats = (
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
	thinking?: ThinkingLevel,
): string => {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	if (thinking) parts.push(`thinking:${thinking}`);
	return parts.join(" ");
};

const stripYamlFrontmatter = (content: string): string => {
	const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	return normalized.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
};

const formatToolCall = (
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ThemeColor, text: string) => string,
): string => {
	if (toolName === "bash") {
		const command = typeof args.command === "string" ? args.command : "...";
		const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
		return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
	}

	if (toolName === "read") {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		let text = themeFg("accent", shortenPath(rawPath));
		if (offset !== undefined || limit !== undefined) {
			const startLine = offset ?? 1;
			const endLine = limit !== undefined ? startLine + limit - 1 : "";
			text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
		}
		return themeFg("muted", "read ") + text;
	}

	if (toolName === "write") {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
		const content = typeof args.content === "string" ? args.content : "";
		const lines = content.split("\n").length;
		let text = themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
		if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
		return text;
	}

	if (toolName === "edit") {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
		return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
	}

	if (toolName === "ls") {
		const rawPath = typeof args.path === "string" ? args.path : ".";
		return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
	}

	if (toolName === "find") {
		const pattern = typeof args.pattern === "string" ? args.pattern : "*";
		const rawPath = typeof args.path === "string" ? args.path : ".";
		return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
	}

	if (toolName === "grep") {
		const pattern = typeof args.pattern === "string" ? args.pattern : "";
		const rawPath = typeof args.path === "string" ? args.path : ".";
		return (
			themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
		);
	}

	const argsStr = JSON.stringify(args);
	const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
	return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
};

const getFinalOutput = (messages: Message[]): string => {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
};

const getDisplayItems = (messages: Message[]): DisplayItem[] => {
	const items: DisplayItem[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
};

const renderDisplayItemsText = (options: {
	items: DisplayItem[];
	expanded: boolean;
	themeFg: (color: ThemeColor, text: string) => string;
	limit?: number;
}): string => {
	const { items, expanded, themeFg, limit } = options;
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;

	let text = "";
	if (skipped > 0) text += themeFg("muted", `... ${skipped} earlier items\n`);

	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
			text += `${themeFg("toolOutput", preview)}\n`;
		} else {
			text += `${themeFg("muted", "→ ") + formatToolCall(item.name, item.args, themeFg)}\n`;
		}
	}

	return text.trimEnd();
};

const aggregateUsage = (results: SingleResult[]): UsageStats => {
	const total: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
	for (const result of results) {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		total.cost += result.usage.cost;
		total.turns += result.usage.turns;
	}
	return total;
};

const formatAvailableSkills = (skills: Skill[], maxItems: number): { text: string; remaining: number } => {
	if (skills.length === 0) return { text: "none", remaining: 0 };
	const listed = skills.slice(0, maxItems);
	const remaining = skills.length - listed.length;
	return {
		text: listed.map((skill) => `${skill.name} (${skill.source})`).join(", "),
		remaining,
	};
};

const buildSkillMessageBase = (skill: Skill): string => {
	const content = fs.readFileSync(skill.filePath, "utf-8");
	const body = stripYamlFrontmatter(content);
	const header = `Skill location: ${skill.filePath}\nReferences are relative to ${skill.baseDir}.`;
	return `${header}\n\n${body}`;
};

type SkillPromptState = {
	skills: Skill[];
	skillByName: Map<string, Skill>;
	baseCache: Map<string, string>;
};

const createSkillPromptState = (skills: Skill[]): SkillPromptState => {
	const skillByName = new Map<string, Skill>();
	for (const skill of skills) skillByName.set(skill.name, skill);
	return { skills, skillByName, baseCache: new Map<string, string>() };
};

const buildSubprocessPrompt = (
	item: TaskWorkItem,
	state: SkillPromptState,
	skillListLimit: number,
): { ok: true; prompt: string } | { ok: false; error: string } => {
	if (!item.skill) return { ok: true, prompt: item.prompt };

	const skill = state.skillByName.get(item.skill);
	if (!skill) {
		const available = formatAvailableSkills(state.skills, skillListLimit);
		const suffix = available.remaining > 0 ? `, ... +${available.remaining} more` : "";
		return {
			ok: false,
			error: `Unknown skill: ${item.skill}\nAvailable skills: ${available.text}${suffix}`,
		};
	}

	let base = state.baseCache.get(skill.name);
	if (!base) {
		try {
			base = buildSkillMessageBase(skill);
			state.baseCache.set(skill.name, base);
		} catch (err) {
			return {
				ok: false,
				error: `Failed to load skill "${skill.name}": ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	}

	return { ok: true, prompt: `${base}\n\n---\n\nUser: ${item.prompt}` };
};

const createPlaceholderResult = (
	item: TaskWorkItem,
	index: number | undefined,
	thinking: ThinkingLevel,
	model: string | undefined,
): SingleResult => {
	return {
		prompt: item.prompt,
		skill: item.skill,
		index,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
		thinking,
	};
};

const getTaskSkillLabel = (result: { skill?: string } | undefined): string | undefined => {
	const skill = result?.skill?.trim();
	return skill ? skill : undefined;
};

const getTaskSummaryLabel = (result: SingleResult): string => {
	const skillLabel = getTaskSkillLabel(result);
	if (skillLabel) return skillLabel;
	if (result.index) return `task ${result.index}`;
	return "task";
};

const isTaskError = (result: SingleResult): boolean => {
	return result.exitCode > 0 || result.stopReason === "error" || result.stopReason === "aborted";
};

const getTaskErrorText = (result: SingleResult): string => {
	return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
};

const attachAbortSignal = (
	proc: ChildProcessWithoutNullStreams,
	signal: AbortSignal | undefined,
): { isAborted: () => boolean } => {
	let aborted = false;
	if (!signal) return { isAborted: () => aborted };

	const killProcess = () => {
		aborted = true;
		proc.kill("SIGTERM");
		setTimeout(() => {
			if (!proc.killed) proc.kill("SIGKILL");
		}, 5000);
	};

	if (signal.aborted) killProcess();
	else signal.addEventListener("abort", killProcess, { once: true });

	return { isAborted: () => aborted };
};

const parseJsonLine = (line: string): Record<string, unknown> | undefined => {
	if (!line.trim()) return undefined;
	try {
		const parsed = JSON.parse(line) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
};

const isMessage = (value: unknown): value is Message => {
	if (!isRecord(value)) return false;
	const role = value.role;
	return role === "assistant" || role === "user" || role === "toolResult";
};

const applyAssistantUsage = (result: SingleResult, message: AssistantMessage): void => {
	result.usage.turns += 1;
	const usage = message.usage;

	result.usage.input += usage.input ?? 0;
	result.usage.output += usage.output ?? 0;
	result.usage.cacheRead += usage.cacheRead ?? 0;
	result.usage.cacheWrite += usage.cacheWrite ?? 0;
	result.usage.cost += usage.cost?.total ?? 0;
	result.usage.contextTokens = usage.totalTokens ?? 0;
};

const handleEventMessage = (result: SingleResult, message: Message): void => {
	result.messages.push(message);

	if (message.role !== "assistant") return;

	applyAssistantUsage(result, message);
	if (!result.model && message.model) result.model = message.model;
	if (message.stopReason) result.stopReason = message.stopReason;
	if (message.errorMessage) result.errorMessage = message.errorMessage;
};

const prepareTaskExecutions = (options: {
	items: TaskWorkItem[];
	state: SkillPromptState;
	skillListLimit: number;
	defaultModel: string | undefined;
	defaultThinking: TaskThinking;
	inheritedThinking: ThinkingLevel;
	ctxModel: { provider: string; id: string } | undefined;
	builtInTools: BuiltInToolName[];
}): { ok: true; executions: PreparedExecution[] } | { ok: false; error: string } => {
	const executions: PreparedExecution[] = [];
	for (const item of options.items) {
		const prepared = buildSubprocessPrompt(item, options.state, options.skillListLimit);
		if (!prepared.ok) return prepared;
		const config = resolveTaskConfig({
			item,
			defaultModel: options.defaultModel,
			defaultThinking: options.defaultThinking,
			inheritedThinking: options.inheritedThinking,
			ctxModel: options.ctxModel,
			builtInTools: options.builtInTools,
		});
		if (!config.ok) return config;
		executions.push({
			task: { item, subprocessPrompt: prepared.prompt },
			config: {
				thinkingLevel: config.thinkingLevel,
				subprocessArgs: config.subprocessArgs,
				modelLabel: config.modelLabel,
			},
		});
	}
	return { ok: true, executions };
};

const mapWithConcurrencyLimit = async <TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> => {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;

	const runWorker = async (): Promise<void> => {
		const currentIndex = nextIndex;
		nextIndex += 1;
		if (currentIndex >= items.length) return;
		results[currentIndex] = await fn(items[currentIndex], currentIndex);
		await runWorker();
	};

	await Promise.all(new Array(limit).fill(null).map(async () => runWorker()));
	return results;
};

const runSingleTask = async (options: {
	defaultCwd: string;
	item: TaskWorkItem;
	subprocessPrompt: string;
	index: number | undefined;
	subprocessArgs: string[];
	modelLabel: string | undefined;
	thinking: ThinkingLevel;
	signal: AbortSignal | undefined;
	onResultUpdate: ((result: SingleResult) => void) | undefined;
}): Promise<SingleResult> => {
	const currentResult: SingleResult = {
		prompt: options.item.prompt,
		skill: options.item.skill,
		index: options.index,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: options.modelLabel,
		thinking: options.thinking,
	};

	const emitUpdate = () => {
		options.onResultUpdate?.(currentResult);
	};

	const args = [...options.subprocessArgs, options.subprocessPrompt];

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn("pi", args, {
			cwd: options.defaultCwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});

		proc.stdin.end();

		const abortState = attachAbortSignal(proc, options.signal);

		let buffer = "";
		const processLine = (line: string) => {
			const event = parseJsonLine(line);
			if (!event) return;
			const typeValue = event.type;
			const typeText = typeof typeValue === "string" ? typeValue : "";
			const messageValue = event.message;
			if ((typeText === "message_end" || typeText === "tool_result_end") && isMessage(messageValue)) {
				handleEventMessage(currentResult, messageValue);
				emitUpdate();
			}
		};

		proc.stdout.on("data", (data) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (data) => {
			currentResult.stderr += data.toString();
		});

		proc.on("close", (code) => {
			if (buffer.trim()) processLine(buffer);
			currentResult.exitCode = code ?? 0;
			if (abortState.isAborted()) currentResult.stopReason = "aborted";
			resolve(code ?? 0);
		});

		proc.on("error", () => {
			currentResult.exitCode = 1;
			resolve(1);
		});
	});

	currentResult.exitCode = exitCode;
	return currentResult;
};

const ModelOverrideSchema = Type.Optional(Type.String({ description: "Optional model override: provider/modelId" }));

const ThinkingOverrideSchema = Type.Optional(
	Type.String({
		enum: [...VALID_THINKING_OPTIONS],
		description: "Thinking level override: off, minimal, low, medium, high, xhigh, or inherit",
	}),
);

const TaskItemSchema = Type.Object({
	prompt: Type.String({ description: "Task prompt" }),
	skill: Type.Optional(Type.String({ description: "Optional skill name" })),
	model: ModelOverrideSchema,
	thinking: ThinkingOverrideSchema,
});

const TaskParams = Type.Object({
	type: Type.String({
		enum: ["single", "chain", "parallel"],
		description: "Execution mode: single prompt, chain or parallel tasks",
	}),
	tasks: Type.Array(TaskItemSchema, {
		minItems: 1,
		description: "Tasks to run (single expects exactly one).",
	}),
	model: ModelOverrideSchema,
	thinking: ThinkingOverrideSchema,
});

const renderSingleResult = (
	result: SingleResult,
	expanded: boolean,
	theme: Theme,
	collapsedItemCount: number,
): Container | Text => {
	const mdTheme = getMarkdownTheme();
	const running = result.exitCode === -1;
	const error = isTaskError(result);
	const icon = running ? theme.fg("warning", "⏳") : error ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const skillLabel = getTaskSkillLabel(result);
	const displayItems = getDisplayItems(result.messages);
	const finalOutput = getFinalOutput(result.messages);

	if (expanded) {
		const container = new Container();
		let header = `${icon} ${theme.fg("toolTitle", theme.bold("task"))}`;
		if (skillLabel) header += ` ${theme.fg("accent", skillLabel)}`;
		if (error && result.stopReason) header += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
		container.addChild(new Text(header, 0, 0));
		if (error && result.errorMessage)
			container.addChild(new Text(theme.fg("error", `Error: ${result.errorMessage}`), 0, 0));

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Prompt ───"), 0, 0));
		if (result.skill)
			container.addChild(new Text(theme.fg("muted", "Skill: ") + theme.fg("accent", result.skill), 0, 0));
		container.addChild(new Text(theme.fg("dim", result.prompt), 0, 0));

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
		if (displayItems.length === 0 && !finalOutput) {
			container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
		} else {
			for (const item of displayItems) {
				if (item.type === "toolCall") {
					container.addChild(
						new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
					);
				}
			}
			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}
		}

		const usageStr = formatUsageStats(result.usage, result.model, result.thinking);
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("task"))}`;
	if (skillLabel) text += ` ${theme.fg("accent", skillLabel)}`;
	if (error && result.stopReason) text += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
	if (error && result.errorMessage) text += `\n${theme.fg("error", `Error: ${result.errorMessage}`)}`;
	else if (displayItems.length === 0)
		text += `\n${theme.fg("muted", result.exitCode === -1 ? "(running...)" : "(no output)")}`;
	else {
		text += `\n${renderDisplayItemsText({ items: displayItems, expanded, themeFg: theme.fg.bind(theme), limit: collapsedItemCount })}`;
		if (displayItems.length > collapsedItemCount) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}

	const usageStr = formatUsageStats(result.usage, result.model, result.thinking);
	if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
	return new Text(text, 0, 0);
};

const renderParallelResult = (results: SingleResult[], expanded: boolean, theme: Theme): Container | Text => {
	const mdTheme = getMarkdownTheme();
	const running = results.filter((result) => result.exitCode === -1).length;
	const successCount = results.filter((result) => result.exitCode === 0 && !isTaskError(result)).length;
	const failCount = results.filter((result) => isTaskError(result)).length;
	const isRunning = running > 0;

	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");

	const status = isRunning
		? `${successCount + failCount}/${results.length} done, ${running} running`
		: `${successCount}/${results.length} tasks`;

	if (expanded && !isRunning) {
		const container = new Container();
		container.addChild(
			new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
		);

		for (const result of results) {
			const taskIcon = isTaskError(result) ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const skillLabel = getTaskSkillLabel(result);
			const label = skillLabel ? `task ${skillLabel}` : "task";
			const displayItems = getDisplayItems(result.messages);
			const finalOutput = getFinalOutput(result.messages);

			container.addChild(new Spacer(1));
			container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", label)} ${taskIcon}`, 0, 0));
			if (result.skill)
				container.addChild(new Text(theme.fg("muted", "Skill: ") + theme.fg("accent", result.skill), 0, 0));
			container.addChild(new Text(theme.fg("muted", "Prompt: ") + theme.fg("dim", result.prompt), 0, 0));

			for (const item of displayItems) {
				if (item.type === "toolCall") {
					container.addChild(
						new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
					);
				}
			}

			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}

			const taskUsage = formatUsageStats(result.usage, result.model, result.thinking);
			if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
		}

		const usageStr = formatUsageStats(aggregateUsage(results));
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
		}
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
	for (const result of results) {
		const taskIcon =
			result.exitCode === -1
				? theme.fg("warning", "⏳")
				: isTaskError(result)
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");
		const skillLabel = getTaskSkillLabel(result);
		const label = skillLabel ? `task ${skillLabel}` : "task";
		const displayItems = getDisplayItems(result.messages);
		text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", label)} ${taskIcon}`;
		if (displayItems.length === 0) {
			text += `\n${theme.fg("muted", result.exitCode === -1 ? "(running...)" : "(no output)")}`;
		} else {
			text += `\n${renderDisplayItemsText({ items: displayItems, expanded: false, themeFg: theme.fg.bind(theme), limit: 5 })}`;
		}
	}

	if (!isRunning) {
		const usageStr = formatUsageStats(aggregateUsage(results));
		if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	}
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;

	return new Text(text, 0, 0);
};

const renderChainResult = (results: SingleResult[], expanded: boolean, theme: Theme): Container | Text => {
	const mdTheme = getMarkdownTheme();
	const running = results.filter((result) => result.exitCode === -1).length;
	const successCount = results.filter((result) => result.exitCode === 0 && !isTaskError(result)).length;
	const failCount = results.filter((result) => isTaskError(result)).length;
	const isRunning = running > 0;

	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("error", "✗")
			: theme.fg("success", "✓");

	const status = isRunning
		? `${successCount + failCount}/${results.length} done, ${running} running`
		: `${successCount}/${results.length} steps`;

	if (expanded) {
		const container = new Container();
		container.addChild(
			new Text(`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", status)}`, 0, 0),
		);

		for (let index = 0; index < results.length; index++) {
			const result = results[index];
			const stepNumber = result.index ?? index + 1;
			const taskIcon =
				result.exitCode === -1
					? theme.fg("warning", "⏳")
					: isTaskError(result)
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
			const skillLabel = getTaskSkillLabel(result) ?? "task";
			const displayItems = getDisplayItems(result.messages);
			const finalOutput = getFinalOutput(result.messages);

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					`${theme.fg("muted", `─── Step ${stepNumber}: `)}${theme.fg("accent", skillLabel)} ${taskIcon}`,
					0,
					0,
				),
			);
			if (result.skill)
				container.addChild(new Text(theme.fg("muted", "Skill: ") + theme.fg("accent", result.skill), 0, 0));
			container.addChild(new Text(theme.fg("muted", "Prompt: ") + theme.fg("dim", result.prompt), 0, 0));
			if (isTaskError(result) && result.errorMessage)
				container.addChild(new Text(theme.fg("error", `Error: ${result.errorMessage}`), 0, 0));

			for (const item of displayItems) {
				if (item.type === "toolCall") {
					container.addChild(
						new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
					);
				}
			}

			if (finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
			}

			const taskUsage = formatUsageStats(result.usage, result.model, result.thinking);
			if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
		}

		const usageStr = formatUsageStats(aggregateUsage(results));
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
		}
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", status)}`;
	for (let index = 0; index < results.length; index++) {
		const result = results[index];
		const stepNumber = result.index ?? index + 1;
		const taskIcon =
			result.exitCode === -1
				? theme.fg("warning", "⏳")
				: isTaskError(result)
					? theme.fg("error", "✗")
					: theme.fg("success", "✓");
		const skillLabel = getTaskSkillLabel(result) ?? "task";
		const displayItems = getDisplayItems(result.messages);
		text += `\n\n${theme.fg("muted", `─── Step ${stepNumber}: `)}${theme.fg("accent", skillLabel)} ${taskIcon}`;
		if (displayItems.length === 0) {
			text += `\n${theme.fg("muted", result.exitCode === -1 ? "(running...)" : "(no output)")}`;
		} else {
			text += `\n${renderDisplayItemsText({ items: displayItems, expanded: false, themeFg: theme.fg.bind(theme), limit: 5 })}`;
		}
	}

	const usageStr = formatUsageStats(aggregateUsage(results));
	if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;

	return new Text(text, 0, 0);
};

export const taskTool = (options: TaskToolOptions) => (pi: ExtensionAPI) => {
	const merged = { ...DEFAULT_OPTIONS, ...options };

	pi.registerTool({
		name: merged.name,
		label: merged.label,
		description: merged.description,
		parameters: TaskParams,

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			const normalized = normalizeTaskParams(params as unknown, { maxParallelTasks: merged.maxParallelTasks });
			if (!normalized.ok) {
				const settings = loadSettings(ctx.cwd);
				const discovery = discoverSkills(ctx.cwd, undefined, settings.skills);
				const available = formatAvailableSkills(discovery.skills, merged.skillListLimit);
				const suffix = available.remaining > 0 ? `, ... +${available.remaining} more` : "";
				return {
					content: [{ type: "text", text: `${normalized.error}\nAvailable skills: ${available.text}${suffix}` }],
					details: { mode: "single", results: [] } as TaskToolDetails,
				};
			}

			const settings = loadSettings(ctx.cwd);
			const discovery = discoverSkills(ctx.cwd, undefined, settings.skills);
			const skillState = createSkillPromptState(discovery.skills);

			const inheritedThinking = pi.getThinkingLevel();
			const builtInTools = getBuiltInToolsFromActiveTools(pi.getActiveTools());
			const ctxModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;

			const makeDetails = (results: SingleResult[]): TaskToolDetails => {
				return { mode: normalized.value.mode, modelOverride: normalized.value.model, results };
			};

			if (normalized.value.mode === "single") {
				const prepared = prepareTaskExecutions({
					items: normalized.value.items,
					state: skillState,
					skillListLimit: merged.skillListLimit,
					defaultModel: normalized.value.model,
					defaultThinking: normalized.value.thinking,
					inheritedThinking,
					ctxModel,
					builtInTools,
				});
				if (!prepared.ok) {
					return {
						content: [{ type: "text", text: prepared.error }],
						details: makeDetails([]),
					};
				}

				const execution = prepared.executions[0];
				const initial = createPlaceholderResult(
					execution.task.item,
					undefined,
					execution.config.thinkingLevel,
					execution.config.modelLabel,
				);
				const emitSingleUpdate = (result: SingleResult) => {
					if (!onUpdate) return;
					onUpdate({
						content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
						details: makeDetails([result]),
					});
				};
				emitSingleUpdate(initial);

				const result = await runSingleTask({
					defaultCwd: ctx.cwd,
					item: execution.task.item,
					subprocessPrompt: execution.task.subprocessPrompt,
					index: undefined,
					subprocessArgs: execution.config.subprocessArgs,
					modelLabel: execution.config.modelLabel,
					thinking: execution.config.thinkingLevel,
					signal,
					onResultUpdate: emitSingleUpdate,
				});

				const error = isTaskError(result);
				if (error) {
					return {
						content: [{ type: "text", text: `Task failed: ${getTaskErrorText(result)}` }],
						details: makeDetails([result]),
					};
				}

				return {
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
					details: makeDetails([result]),
				};
			}

			if (normalized.value.mode === "chain") {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let index = 0; index < normalized.value.items.length; index++) {
					const item = normalized.value.items[index];
					const prompt = item.prompt.replace(/\{previous\}/g, previousOutput);
					const stepItem = { ...item, prompt };

					const config = resolveTaskConfig({
						item,
						defaultModel: normalized.value.model,
						defaultThinking: normalized.value.thinking,
						inheritedThinking,
						ctxModel,
						builtInTools,
					});
					if (!config.ok) {
						return {
							content: [{ type: "text", text: config.error }],
							details: makeDetails(results),
						};
					}

					const preparedPrompt = buildSubprocessPrompt(stepItem, skillState, merged.skillListLimit);
					if (!preparedPrompt.ok) {
						return {
							content: [{ type: "text", text: preparedPrompt.error }],
							details: makeDetails(results),
						};
					}

					const placeholder = createPlaceholderResult(
						stepItem,
						index + 1,
						config.thinkingLevel,
						config.modelLabel,
					);
					if (onUpdate) {
						onUpdate({
							content: [{ type: "text", text: "(running...)" }],
							details: makeDetails([...results, placeholder]),
						});
					}

					const chainUpdate = onUpdate
						? (partial: SingleResult) => {
								onUpdate({
									content: [{ type: "text", text: getFinalOutput(partial.messages) || "(running...)" }],
									details: makeDetails([...results, partial]),
								});
							}
						: undefined;

					const result = await runSingleTask({
						defaultCwd: ctx.cwd,
						item: stepItem,
						subprocessPrompt: preparedPrompt.prompt,
						index: index + 1,
						subprocessArgs: config.subprocessArgs,
						modelLabel: config.modelLabel,
						thinking: config.thinkingLevel,
						signal,
						onResultUpdate: chainUpdate,
					});
					results.push(result);

					if (isTaskError(result)) {
						return {
							content: [
								{ type: "text", text: `Chain stopped at step ${index + 1}: ${getTaskErrorText(result)}` },
							],
							details: makeDetails(results),
							isError: true,
						};
					}

					previousOutput = getFinalOutput(result.messages);
				}

				const last = results[results.length - 1];
				return {
					content: [{ type: "text", text: getFinalOutput(last.messages) || "(no output)" }],
					details: makeDetails(results),
				};
			}

			const prepared = prepareTaskExecutions({
				items: normalized.value.items,
				state: skillState,
				skillListLimit: merged.skillListLimit,
				defaultModel: normalized.value.model,
				defaultThinking: normalized.value.thinking,
				inheritedThinking,
				ctxModel,
				builtInTools,
			});
			if (!prepared.ok) {
				return {
					content: [{ type: "text", text: prepared.error }],
					details: makeDetails([]),
				};
			}

			const allResults = prepared.executions.map((execution, index) =>
				createPlaceholderResult(
					execution.task.item,
					index + 1,
					execution.config.thinkingLevel,
					execution.config.modelLabel,
				),
			);

			const emitParallelUpdate = () => {
				if (!onUpdate) return;
				const running = allResults.filter((result) => result.exitCode === -1).length;
				const done = allResults.filter((result) => result.exitCode !== -1).length;
				onUpdate({
					content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
					details: makeDetails([...allResults]),
				});
			};

			emitParallelUpdate();

			const results = await mapWithConcurrencyLimit(
				prepared.executions,
				merged.maxConcurrency,
				async (execution, index) => {
					const result = await runSingleTask({
						defaultCwd: ctx.cwd,
						item: execution.task.item,
						subprocessPrompt: execution.task.subprocessPrompt,
						index: index + 1,
						subprocessArgs: execution.config.subprocessArgs,
						modelLabel: execution.config.modelLabel,
						thinking: execution.config.thinkingLevel,
						signal,
						onResultUpdate: (partial) => {
							allResults[index] = partial;
							emitParallelUpdate();
						},
					});
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				},
			);

			const successCount = results.filter((result) => !isTaskError(result)).length;
			const summaries = results.map((result) => {
				const output = getFinalOutput(result.messages);
				const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
				return `[${getTaskSummaryLabel(result)}] ${isTaskError(result) ? "failed" : "completed"}: ${preview || "(no output)"}`;
			});

			return {
				content: [
					{
						type: "text",
						text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
					},
				],
				details: makeDetails(results),
			};
		},

		renderCall(args, theme) {
			const tasks = Array.isArray(args.tasks) ? args.tasks : [];

			if (args.type === "chain") {
				let text = theme.fg("toolTitle", theme.bold("task ")) + theme.fg("accent", `chain (${tasks.length} steps)`);
				if (typeof args.model === "string" && args.model.trim())
					text += theme.fg("muted", ` [${args.model.trim()}]`);
				for (let index = 0; index < Math.min(tasks.length, 3); index++) {
					const task = tasks[index];
					const skillLabel = typeof task.skill === "string" && task.skill.trim() ? task.skill.trim() : undefined;
					const prompt = typeof task.prompt === "string" ? task.prompt : "";
					const preview = prompt.length > 40 ? `${prompt.slice(0, 40)}...` : prompt;
					const line = skillLabel
						? `${theme.fg("accent", skillLabel)}${theme.fg("dim", ` ${preview || "..."}`)}`
						: theme.fg("dim", preview || "...");
					text += `\n  ${theme.fg("muted", `${index + 1}.`)} ${line}`;
				}
				if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			if (args.type === "parallel") {
				let text =
					theme.fg("toolTitle", theme.bold("task ")) + theme.fg("accent", `parallel (${tasks.length} tasks)`);
				if (typeof args.model === "string" && args.model.trim())
					text += theme.fg("muted", ` [${args.model.trim()}]`);
				for (const task of tasks.slice(0, 3)) {
					const skillLabel = typeof task.skill === "string" && task.skill.trim() ? task.skill.trim() : undefined;
					const prompt = typeof task.prompt === "string" ? task.prompt : "";
					const preview = prompt.length > 40 ? `${prompt.slice(0, 40)}...` : prompt;
					const line = skillLabel
						? `${theme.fg("accent", skillLabel)}${theme.fg("dim", ` ${preview || "..."}`)}`
						: theme.fg("dim", preview || "...");
					text += `\n  ${line}`;
				}
				if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			const task = tasks[0] ?? {};
			const skillLabel = typeof task.skill === "string" && task.skill.trim() ? task.skill.trim() : undefined;
			const prompt = typeof task.prompt === "string" ? task.prompt : "";
			const preview = prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt;
			let text = theme.fg("toolTitle", theme.bold("task"));
			if (skillLabel) text += ` ${theme.fg("accent", skillLabel)}`;
			if (typeof args.model === "string" && args.model.trim()) text += theme.fg("muted", ` [${args.model.trim()}]`);
			text += `\n  ${theme.fg("dim", preview || "...")}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as TaskToolDetails | undefined;
			if (!details || details.results.length === 0) {
				const textBlock = result.content[0];
				return new Text(textBlock?.type === "text" ? textBlock.text : "(no output)", 0, 0);
			}

			if (details.mode === "single" && details.results.length === 1) {
				return renderSingleResult(details.results[0], expanded, theme, merged.collapsedItemCount);
			}

			if (details.mode === "chain") {
				return renderChainResult(details.results, expanded, theme);
			}

			if (details.mode === "parallel") {
				return renderParallelResult(details.results, expanded, theme);
			}

			const textBlock = result.content[0];
			return new Text(textBlock?.type === "text" ? textBlock.text : "(no output)", 0, 0);
		},
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		return {
			systemPrompt: applyPromptPatches(event.systemPrompt, merged.systemPromptPatches),
		};
	});
};
