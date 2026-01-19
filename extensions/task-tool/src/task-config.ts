import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ProviderModel, TaskThinking, TaskWorkItem } from "./task-params.js";
import { resolveModel } from "./task-params.js";

const BUILT_IN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export type BuiltInToolName = (typeof BUILT_IN_TOOLS)[number];

const isBuiltInToolName = (toolName: string): toolName is BuiltInToolName => {
	return (BUILT_IN_TOOLS as readonly string[]).includes(toolName);
};

export const getBuiltInToolsFromActiveTools = (activeTools: string[]): BuiltInToolName[] => {
	return activeTools.filter(isBuiltInToolName);
};

const resolveThinkingLevel = (thinking: TaskThinking, inherited: ThinkingLevel): ThinkingLevel => {
	return thinking === "inherit" ? inherited : thinking;
};

const buildSubprocessArgs = (options: {
	model: ProviderModel | undefined;
	thinkingLevel: ThinkingLevel;
	builtInTools: BuiltInToolName[];
}): string[] => {
	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-extensions"];

	if (options.model) {
		args.push("--provider", options.model.provider);
		args.push("--model", options.model.modelId);
	}

	args.push("--thinking", options.thinkingLevel);

	if (options.builtInTools.length === 0) {
		args.push("--no-tools");
	} else {
		args.push("--tools", options.builtInTools.join(","));
	}

	return args;
};

export const resolveTaskConfig = (options: {
	item: TaskWorkItem;
	defaultModel: string | undefined;
	defaultThinking: TaskThinking;
	inheritedThinking: ThinkingLevel;
	ctxModel: { provider: string; id: string } | undefined;
	builtInTools: BuiltInToolName[];
}):
	| { ok: true; thinkingLevel: ThinkingLevel; subprocessArgs: string[]; modelLabel: string | undefined }
	| { ok: false; error: string } => {
	const modelOverride = options.item.model ?? options.defaultModel;
	const modelResolution = resolveModel(modelOverride, options.ctxModel);
	if (!modelResolution.ok) return modelResolution;

	const thinking = resolveThinkingLevel(options.item.thinking ?? options.defaultThinking, options.inheritedThinking);
	const subprocessArgs = buildSubprocessArgs({
		model: modelResolution.model,
		thinkingLevel: thinking,
		builtInTools: options.builtInTools,
	});

	return { ok: true, thinkingLevel: thinking, subprocessArgs, modelLabel: modelResolution.model?.label };
};
