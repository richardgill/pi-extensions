export const MAX_PARALLEL_TASKS = 8;
export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const VALID_THINKING_OPTIONS = ["inherit", ...VALID_THINKING_LEVELS] as const;

export type TaskThinking = (typeof VALID_THINKING_OPTIONS)[number];

export type TaskWorkItem = {
	prompt: string;
	skill?: string;
	model?: string;
	thinking?: TaskThinking;
	fork: boolean;
};

export type ProviderModel = {
	provider: string;
	modelId: string;
	label: string;
};

export type NormalizedParams =
	| { mode: "single"; model?: string; thinking: TaskThinking; items: [TaskWorkItem] }
	| { mode: "parallel"; model?: string; thinking: TaskThinking; items: TaskWorkItem[] }
	| { mode: "chain"; model?: string; thinking: TaskThinking; items: TaskWorkItem[] };

export const isRecord = (value: unknown): value is Record<string, unknown> => {
	return value !== null && typeof value === "object";
};

const isTaskThinking = (value: string): value is TaskThinking => {
	return (VALID_THINKING_OPTIONS as readonly string[]).includes(value);
};

const parseProviderModel = (value: string): { ok: true; model: ProviderModel } | { ok: false; error: string } => {
	const trimmed = value.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
		return { ok: false, error: `Invalid model format: "${value}". Expected provider/modelId.` };
	}
	const provider = trimmed.slice(0, slashIndex);
	const modelId = trimmed.slice(slashIndex + 1);
	return { ok: true, model: { provider, modelId, label: `${provider}/${modelId}` } };
};

export const resolveModel = (
	modelOverride: string | undefined,
	ctxModel: { provider: string; id: string } | undefined,
): { ok: true; model: ProviderModel | undefined } | { ok: false; error: string } => {
	if (modelOverride) {
		const parsed = parseProviderModel(modelOverride);
		if (!parsed.ok) return parsed;
		return { ok: true, model: parsed.model };
	}

	if (!ctxModel) return { ok: true, model: undefined };
	return {
		ok: true,
		model: { provider: ctxModel.provider, modelId: ctxModel.id, label: `${ctxModel.provider}/${ctxModel.id}` },
	};
};

const normalizeModelInput = (
	value: unknown,
	label: string,
): { ok: true; value?: string } | { ok: false; error: string } => {
	if (value === undefined) return { ok: true, value: undefined };
	if (typeof value !== "string") return { ok: false, error: `Invalid parameters: ${label} must be a string.` };
	const trimmed = value.trim();
	return { ok: true, value: trimmed ? trimmed : undefined };
};

const normalizeThinkingInput = (
	value: unknown,
	label: string,
): { ok: true; value?: TaskThinking } | { ok: false; error: string } => {
	if (value === undefined) return { ok: true, value: undefined };
	if (typeof value !== "string") return { ok: false, error: `Invalid parameters: ${label} must be a string.` };
	const trimmed = value.trim();
	if (!trimmed) return { ok: true, value: undefined };
	if (!isTaskThinking(trimmed)) {
		return {
			ok: false,
			error: `Invalid parameters: ${label} must be one of ${VALID_THINKING_OPTIONS.join(", ")}.`,
		};
	}
	return { ok: true, value: trimmed };
};

const normalizeForkInput = (
	value: unknown,
	label: string,
): { ok: true; value: boolean } | { ok: false; error: string } => {
	if (value === undefined) return { ok: true, value: true };
	if (typeof value !== "boolean") return { ok: false, error: `Invalid parameters: ${label} must be a boolean.` };
	return { ok: true, value };
};

const parseTaskItems = (rawTasks: unknown[]): { ok: true; items: TaskWorkItem[] } | { ok: false; error: string } => {
	const items: TaskWorkItem[] = [];
	for (const [index, taskEntry] of rawTasks.entries()) {
		if (!isRecord(taskEntry)) return { ok: false, error: "Invalid task item: expected an object." };
		const prompt = typeof taskEntry.prompt === "string" ? taskEntry.prompt.trim() : "";
		const skill = typeof taskEntry.skill === "string" ? taskEntry.skill.trim() : undefined;
		if (!prompt && !skill) {
			return { ok: false, error: 'Invalid task item: provide a non-empty "prompt" or "skill".' };
		}

		const modelResult = normalizeModelInput(taskEntry.model, `"tasks[${index}].model"`);
		if (!modelResult.ok) return modelResult;

		const thinkingResult = normalizeThinkingInput(taskEntry.thinking, `"tasks[${index}].thinking"`);
		if (!thinkingResult.ok) return thinkingResult;

		const forkResult = normalizeForkInput(taskEntry.fork, `"tasks[${index}].fork"`);
		if (!forkResult.ok) return forkResult;

		items.push({
			prompt,
			skill,
			model: modelResult.value,
			thinking: thinkingResult.value,
			fork: forkResult.value,
		});
	}
	return { ok: true, items };
};

export const normalizeTaskParams = (
	params: unknown,
	options: { maxParallelTasks: number } = { maxParallelTasks: MAX_PARALLEL_TASKS },
): { ok: true; value: NormalizedParams } | { ok: false; error: string } => {
	if (!isRecord(params)) return { ok: false, error: "Invalid parameters: expected an object." };

	const mode = params.type;
	if (typeof mode !== "string") return { ok: false, error: 'Invalid parameters: "type" must be a string.' };

	const modelResult = normalizeModelInput(params.model, '"model"');
	if (!modelResult.ok) return modelResult;
	const model = modelResult.value;

	const thinkingResult = normalizeThinkingInput(params.thinking, '"thinking"');
	if (!thinkingResult.ok) return thinkingResult;
	const thinking = thinkingResult.value ?? "inherit";

	const rawTasks = Array.isArray(params.tasks) ? params.tasks : [];

	if (mode === "single") {
		if (rawTasks.length !== 1) {
			return { ok: false, error: 'Invalid parameters: type="single" requires exactly one task in "tasks".' };
		}
		const parsed = parseTaskItems(rawTasks);
		if (!parsed.ok) return parsed;
		return { ok: true, value: { mode: "single", model, thinking, items: [parsed.items[0]] } };
	}

	if (mode === "parallel") {
		if (rawTasks.length === 0) {
			return { ok: false, error: 'Invalid parameters: type="parallel" requires a non-empty "tasks" array.' };
		}
		if (rawTasks.length > options.maxParallelTasks) {
			return {
				ok: false,
				error: `Too many parallel tasks (${rawTasks.length}). Max is ${options.maxParallelTasks}.`,
			};
		}
		const parsed = parseTaskItems(rawTasks);
		if (!parsed.ok) return parsed;
		return { ok: true, value: { mode: "parallel", model, thinking, items: parsed.items } };
	}

	if (mode === "chain") {
		if (rawTasks.length === 0) {
			return { ok: false, error: 'Invalid parameters: type="chain" requires a non-empty "tasks" array.' };
		}
		if (rawTasks.length > options.maxParallelTasks) {
			return {
				ok: false,
				error: `Too many chain tasks (${rawTasks.length}). Max is ${options.maxParallelTasks}.`,
			};
		}
		const parsed = parseTaskItems(rawTasks);
		if (!parsed.ok) return parsed;
		return { ok: true, value: { mode: "chain", model, thinking, items: parsed.items } };
	}

	return { ok: false, error: 'Invalid parameters: "type" must be "single", "chain", or "parallel".' };
};
