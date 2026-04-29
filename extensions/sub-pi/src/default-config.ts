import { loadConfigOrDefault } from "pi-config";
import { type SubPiOptions, subPi } from "sub-pi";
import { z } from "zod";

type PromptPatchConfig = { match: string; flags?: string; replace: string };

const defaultPromptPatches: PromptPatchConfig[] = [
  {
    match:
      "\\n\\s*\\n\\s*in addition to the tools above, you may have access to other custom tools depending on the project\\.",
    flags: "i",
    replace: "\n- sub-pi: never run this tool unless it's a skill run or I explictly ask you to",
  },
];

const defaultOptions: SubPiOptions = {
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
  systemPromptPatches: defaultPromptPatches.map((patch) => ({
    match: new RegExp(patch.match, patch.flags),
    replace: patch.replace,
  })),
};

const PromptPatchSchema = z.object({
  match: z.string(),
  flags: z.string().optional(),
  replace: z.string(),
});

const ConfigSchema = z.object({
  name: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  maxParallelTasks: z.number().int().positive().optional(),
  maxConcurrency: z.number().int().positive().optional(),
  collapsedItemCount: z.number().int().nonnegative().optional(),
  skillListLimit: z.number().int().nonnegative().optional(),
  systemPromptPatches: z.array(PromptPatchSchema).optional(),
});

const toPromptPatch = (patch: PromptPatchConfig): SubPiOptions["systemPromptPatches"][number] => ({
  match: new RegExp(patch.match, patch.flags),
  replace: patch.replace,
});

const config = loadConfigOrDefault({ filename: "sub-pi.jsonc", schema: ConfigSchema });

export default subPi({
  ...defaultOptions,
  ...config,
  systemPromptPatches: (config.systemPromptPatches ?? defaultPromptPatches).map(toPromptPatch),
} satisfies SubPiOptions);
