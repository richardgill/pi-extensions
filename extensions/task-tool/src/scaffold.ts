import { taskTool } from "task-tool";

type PromptPatch = { match: RegExp; replace: string };

type TaskToolOptions = {
	name: string;
	label: string;
	description: string;
	maxParallelTasks: number;
	maxConcurrency: number;
	collapsedItemCount: number;
	skillListLimit: number;
	systemPromptPatches: PromptPatch[];
};

const extension = taskTool({
	name: "task",
	label: "Task",
	description: [
		"Run isolated pi subprocess tasks (single, chain, or parallel).",
		"Supports optional skill wrapper (matches /skill: behavior) and optional model override (provider/modelId).",
	].join(" "),
	maxParallelTasks: 8,
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
} satisfies TaskToolOptions);

export default extension;
