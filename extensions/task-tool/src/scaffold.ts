import { type TaskToolOptions, taskTool } from "task-tool";

const extension = taskTool({
	name: "task",
	label: "Task",
	description: [
		"Run isolated pi subprocess tasks (single, chain, or parallel).",
		"Optional model override (provider/modelId).",
	].join(" "),
	maxParallelTasks: 8,
	maxConcurrency: 4,
	collapsedItemCount: 10,
	skillListLimit: 30,
	systemPromptPatches: [
		{
			match:
				/\n\s*\n\s*in addition to the tools above, you may have access to other custom tools depending on the project\./i,
			replace:
				"\n- task: never run this tool unless it's a skill run or I explictly ask you to",
		},
	],
} satisfies TaskToolOptions);

export default extension;
