import { type SubPiOptions, subPi } from "sub-pi";

export default subPi({
	name: "sub-pi",
	label: "Sub Pi",
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
			replace: "\n- sub-pi: never run this tool unless it's a skill run or I explictly ask you to",
		},
	],
} satisfies SubPiOptions);
