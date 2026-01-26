import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	SessionStartEvent,
	ToolCallEvent,
	TurnEndEvent,
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

type SubProcessContext = "fork" | "fresh";

type TaskToolTask = {
	skill: string;
	prompt: string;
	fork?: boolean;
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
			subProcess?: boolean;
			subProcessContext?: string;
			model?: string;
			thinkingLevel?: string;
		};
	};
};

type SkillPiMetadata = {
	subProcess: boolean;
	subProcessContext: SubProcessContext;
	model?: string;
	thinkingLevel?: string;
};

type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0];

type ModelOverrideParse =
	| { ok: true; provider: string; modelId: string }
	| { ok: false; error: string };

const VALID_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const VALID_SUBPROCESS_CONTEXTS: SubProcessContext[] = ["fork", "fresh"];

const skillCommandPrefix = "/skill:";

let extensionApi: ExtensionAPI | null = null;
let lastPrompt: string | null = null;
let pendingSkill: SkillInvocation | null = null;
let appliedOverrideSkills = new Set<string>();
let handlersRegistered = false;

const taskToolRequiredMessage =
	"skill-task requires task-tool extension to be loaded (tool name: task).";

const notify = (ctx: ExtensionContext, message: string): void => {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.notify(message, "info");
};

const parseModelOverride = (value: string): ModelOverrideParse => {
	const trimmed = value.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
		return { ok: false, error: `Invalid model format: "${value}". Expected provider/modelId.` };
	}
	const provider = trimmed.slice(0, slashIndex).trim();
	const modelId = trimmed.slice(slashIndex + 1).trim();
	if (!provider || !modelId) {
		return { ok: false, error: `Invalid model format: "${value}". Expected provider/modelId.` };
	}
	return { ok: true, provider, modelId };
};

const isThinkingLevel = (value: string): value is ThinkingLevel =>
	(VALID_THINKING_LEVELS as readonly string[]).includes(value);

const isSubProcessContext = (value: string): value is SubProcessContext =>
	(VALID_SUBPROCESS_CONTEXTS as readonly string[]).includes(value);

const applyModelOverride = async (
	ctx: ExtensionContext,
	modelOverride: string | undefined,
): Promise<void> => {
	if (!extensionApi || !modelOverride) {
		return;
	}

	const parsed = parseModelOverride(modelOverride);
	if (!parsed.ok) {
		notify(ctx, parsed.error);
		return;
	}

	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		notify(ctx, `Model ${parsed.provider}/${parsed.modelId} not found`);
		return;
	}

	const success = await extensionApi.setModel(model);
	if (!success) {
		notify(ctx, `No API key for ${parsed.provider}/${parsed.modelId}`);
	}
};

const applyThinkingOverride = (
	ctx: ExtensionContext,
	thinkingLevel: string | undefined,
): void => {
	if (!extensionApi || !thinkingLevel) {
		return;
	}

	if (isThinkingLevel(thinkingLevel)) {
		extensionApi.setThinkingLevel(thinkingLevel);
		return;
	}

	notify(ctx, `Invalid thinkingLevel: ${thinkingLevel}`);
};

const applySkillOverrides = async (
	ctx: ExtensionContext,
	metadata: SkillPiMetadata,
): Promise<void> => {
	await applyModelOverride(ctx, metadata.model);
	applyThinkingOverride(ctx, metadata.thinkingLevel);
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

const normalizeSubProcess = (value: unknown): boolean => value === true;

const normalizeSubProcessContext = (value: unknown): SubProcessContext => {
	if (typeof value !== "string") {
		return "fork";
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return "fork";
	}

	return isSubProcessContext(trimmed) ? trimmed : "fork";
};

export const parseSkillMetadata = (content: string): SkillPiMetadata => {
	const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);
	const piMetadata = frontmatter.metadata?.pi;

	return {
		subProcess: normalizeSubProcess(piMetadata?.subProcess),
		subProcessContext: normalizeSubProcessContext(piMetadata?.subProcessContext),
		model: normalizeOptionalString(piMetadata?.model),
		thinkingLevel: normalizeOptionalString(piMetadata?.thinkingLevel),
	};
};

const loadSkillMetadata = (filePath: string): SkillPiMetadata => {
	try {
		const content = readFileSync(filePath, "utf-8");
		return parseSkillMetadata(content);
	} catch {
		return { subProcess: false, subProcessContext: "fork" };
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
				fork: metadata.subProcessContext === "fork",
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
	return `Call the task tool with the following JSON. Respond only with the tool call.\n${JSON.stringify(params)}`;
};

const isTaskToolRegistered = (pi: ExtensionAPI): boolean =>
	pi.getAllTools().some((tool) => tool.name === "task");

const assertTaskToolRegistered = (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): void => {
	if (isTaskToolRegistered(pi)) {
		return;
	}

	if (ctx.hasUI) {
		ctx.ui.notify(taskToolRequiredMessage, "error");
	}

	process.stderr.write(`${taskToolRequiredMessage}\n`);
	throw new Error(taskToolRequiredMessage);
};

const registerSkillTaskHandlers = (pi: ExtensionAPI): void => {
	if (handlersRegistered) {
		return;
	}

	handlersRegistered = true;
	pi.on("input", handleInput);
	pi.on("tool_call", handleToolCall);
	pi.on("turn_end", handleTurnEnd);
};

const handleTurnEnd = (_event: TurnEndEvent): void => {
	appliedOverrideSkills.clear();
};

const handleSessionStart = async (
	_event: SessionStartEvent,
	ctx: ExtensionContext,
): Promise<void> => {
	if (!extensionApi) {
		return;
	}

	assertTaskToolRegistered(extensionApi, ctx);
	registerSkillTaskHandlers(extensionApi);
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

	if (!metadata.subProcess) {
		pendingSkill = null;
		await applySkillOverrides(ctx, metadata);
		appliedOverrideSkills.add(skillCommand.name);
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

	if (!metadata.subProcess) {
		if (appliedOverrideSkills.has(skillName)) {
			return;
		}
		await applySkillOverrides(ctx, metadata);
		appliedOverrideSkills.add(skillName);
		return;
	}

	const prompt = pendingPrompt ?? lastPrompt ?? "";
	sendTaskTool(ctx, skillName, prompt, metadata);
	return { block: true, reason: `Skill handled by task: ${skillName}` };
};

export const skillTask = () => {
	return (pi: ExtensionAPI): void => {
		extensionApi = pi;
		pi.on("session_start", handleSessionStart);
	};
};
