import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	ToolCallEvent,
} from "@mariozechner/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

type SkillInvocation = {
	name: string;
	prompt: string;
};

type ToolCallResult = {
	block?: boolean;
	reason?: string;
};

type TaskToolTask = {
	skill: string;
	prompt: string;
};

type TaskToolParams = {
	type: "single";
	tasks: TaskToolTask[];
	model?: string;
	thinking?: string;
};

type SkillFrontmatter = {
	metadata?: {
		pi?: {
			forkContext?: boolean;
			model?: string;
			thinkingLevel?: string;
		};
	};
};

type SkillPiMetadata = {
	forkContext: boolean;
	model?: string;
	thinkingLevel?: string;
};

const skillCommandPrefix = "/skill:";

let extensionApi: ExtensionAPI | null = null;
let lastPrompt: string | null = null;
let pendingSkill: SkillInvocation | null = null;

const notify = (ctx: ExtensionContext, message: string): void => {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.notify(message, "info");
};

export const parseSkillCommand = (text: string): SkillInvocation | null => {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith(skillCommandPrefix)) {
		return null;
	}

	const rest = trimmed.slice(skillCommandPrefix.length).trim();
	if (!rest) {
		return null;
	}

	const parts = rest.split(/\s+/);
	const name = parts[0];
	if (!name) {
		return null;
	}

	const prompt = parts.slice(1).join(" ");
	return { name, prompt };
};

const isSkillFile = (filePath: string): boolean =>
	path.basename(filePath) === "SKILL.md";

const getSkillNameFromPath = (filePath: string): string =>
	path.basename(path.dirname(filePath));

const normalizePrompt = (prompt: string): string => prompt.trim();

const normalizeOptionalString = (value: unknown): string | undefined => {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

export const parseSkillMetadata = (content: string): SkillPiMetadata => {
	const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
	const piMetadata = frontmatter.metadata?.pi;

	return {
		forkContext: piMetadata?.forkContext === true,
		model: normalizeOptionalString(piMetadata?.model),
		thinkingLevel: normalizeOptionalString(piMetadata?.thinkingLevel),
	};
};

const loadSkillMetadata = (filePath: string): SkillPiMetadata => {
	try {
		const content = readFileSync(filePath, "utf-8");
		return parseSkillMetadata(content);
	} catch {
		return { forkContext: false };
	}
};

const getSkillRootDirs = (ctx: ExtensionContext): string[] => {
	return [
		path.join(getAgentDir(), "skills"),
		path.join(ctx.cwd, ".pi", "skills"),
		path.join(ctx.cwd, ".claude", "skills"),
	];
};

const getSkillPathCandidates = (
	ctx: ExtensionContext,
	skillName: string,
): string[] => {
	const candidates: string[] = [];
	for (const root of getSkillRootDirs(ctx)) {
		candidates.push(path.join(root, `${skillName}.md`));
		candidates.push(path.join(root, skillName, "SKILL.md"));
	}
	return candidates;
};

const resolveSkillPath = (
	ctx: ExtensionContext,
	skillName: string,
): string | null => {
	for (const candidate of getSkillPathCandidates(ctx, skillName)) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
};

const loadSkillMetadataByName = (
	ctx: ExtensionContext,
	skillName: string,
): SkillPiMetadata | null => {
	const skillPath = resolveSkillPath(ctx, skillName);
	if (!skillPath) {
		return null;
	}

	return loadSkillMetadata(skillPath);
};

const consumePendingSkillPrompt = (skillName: string): string | null => {
	if (!pendingSkill || pendingSkill.name !== skillName) {
		return null;
	}

	const prompt = pendingSkill.prompt;
	pendingSkill = null;
	return prompt;
};

const buildTaskParams = (
	skillName: string,
	prompt: string,
	metadata: SkillPiMetadata,
): TaskToolParams => {
	const params: TaskToolParams = {
		type: "single",
		tasks: [
			{
				skill: skillName,
				prompt: normalizePrompt(prompt),
			},
		],
	};

	const model = metadata.model;
	if (model) {
		params.model = model;
	}

	const thinkingLevel = metadata.thinkingLevel;
	if (thinkingLevel) {
		params.thinking = thinkingLevel;
	}

	return params;
};

const formatTaskMessage = (params: TaskToolParams): string => {
	return `Spawning skill: ${params.tasks[0]?.skill ?? "unknown"} in a task`;
};

const hasTaskTool = (): boolean => {
	if (!extensionApi) {
		return false;
	}

	return extensionApi.getActiveTools().includes("task");
};

const sendTaskTool = (
	ctx: ExtensionContext,
	skillName: string,
	prompt: string,
	metadata: SkillPiMetadata,
): void => {
	if (!extensionApi) {
		return;
	}

	if (!hasTaskTool()) {
		notify(ctx, `Task tool not active for skill: ${skillName}`);
		return;
	}

	const params = buildTaskParams(skillName, prompt, metadata);
	notify(ctx, `Skill task: ${skillName}`);

	const message = formatTaskMessage(params);
	const options = ctx.isIdle() ? undefined : { deliverAs: "steer" as const };
	if (options) {
		extensionApi.sendUserMessage(message, options);
		return;
	}

	extensionApi.sendUserMessage(message);
};

const handleInput = async (
	event: InputEvent,
	ctx: ExtensionContext,
): Promise<InputEventResult | undefined> => {
	if (event.source === "extension") {
		return;
	}

	lastPrompt = event.text;

	const skillCommand = parseSkillCommand(event.text);
	if (!skillCommand) {
		pendingSkill = null;
		return;
	}

	pendingSkill = skillCommand;
	const metadata = loadSkillMetadataByName(ctx, skillCommand.name);
	if (!metadata) {
		pendingSkill = null;
		return;
	}

	if (!metadata.forkContext) {
		pendingSkill = null;
		return;
	}

	pendingSkill = null;
	sendTaskTool(ctx, skillCommand.name, skillCommand.prompt, metadata);
	return { action: "handled" };
};

const handleToolCall = async (
	event: ToolCallEvent,
	ctx: ExtensionContext,
): Promise<ToolCallResult | undefined> => {
	if (event.toolName !== "read") {
		return;
	}

	const inputPath = event.input.path;
	if (typeof inputPath !== "string") {
		return;
	}

	if (!isSkillFile(inputPath)) {
		return;
	}

	const skillName = getSkillNameFromPath(inputPath);
	const pendingPrompt = consumePendingSkillPrompt(skillName);
	const metadata = loadSkillMetadata(inputPath);

	if (!metadata.forkContext) {
		return;
	}

	const prompt = pendingPrompt ?? lastPrompt ?? "";
	sendTaskTool(ctx, skillName, prompt, metadata);
	return { block: true, reason: `Skill handled by task: ${skillName}` };
};

export const skillTask = () => {
	return (pi: ExtensionAPI): void => {
		extensionApi = pi;
		pi.on("input", handleInput);
		pi.on("tool_call", handleToolCall);
	};
};
