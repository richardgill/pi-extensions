import { loadConfigOrDefault } from "@richardgill/pi-config";
import {
  DEFAULT_OPTIONS,
  type PromptPatch,
  type SubPiOptions,
  subPi,
} from "@richardgill/pi-sub-pi";
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

const defaultConfig = {
  ...DEFAULT_OPTIONS,
  description: [
    "Run isolated pi subprocess tasks (single, chain, or parallel).",
    "Optional model override (provider/modelId).",
  ].join(" "),
  maxParallelTasks: 8,
  systemPromptPatches: defaultPromptPatches,
};

const PromptPatchSchema = z.object({
  match: z.string(),
  flags: z.string().optional(),
  replace: z.string(),
});

const ConfigSchema = z.object({
  name: z.string().default(defaultConfig.name),
  label: z.string().default(defaultConfig.label),
  description: z.string().default(defaultConfig.description),
  maxParallelTasks: z.number().int().positive().default(defaultConfig.maxParallelTasks),
  maxConcurrency: z.number().int().positive().default(defaultConfig.maxConcurrency),
  collapsedItemCount: z.number().int().nonnegative().default(defaultConfig.collapsedItemCount),
  skillListLimit: z.number().int().nonnegative().default(defaultConfig.skillListLimit),
  systemPromptPatches: z
    .array(PromptPatchSchema)
    .default(() => defaultConfig.systemPromptPatches.map((patch) => ({ ...patch }))),
});

const toPromptPatch = (patch: PromptPatchConfig): PromptPatch => ({
  match: new RegExp(patch.match, patch.flags),
  replace: patch.replace,
});

const config = loadConfigOrDefault({
  filename: "sub-pi.jsonc",
  schema: ConfigSchema,
});

export default subPi({
  ...config,
  systemPromptPatches: config.systemPromptPatches.map(toPromptPatch),
} satisfies SubPiOptions);
