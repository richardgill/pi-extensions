import { loadConfigOrDefault, templatedString } from "@richardgill/pi-config";
import { DEFAULT_OPTIONS, taskContext } from "@richardgill/pi-task-context";
import { z } from "zod";

const ThinkingLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);

const ConfigSchema = z.object({
  outputPath: z.string().optional(),
  currentOutputPath: z.union([z.string(), z.literal(false)]).optional(),
  maxSnapshots: z.number().int().positive().optional(),
  model: z
    .object({
      provider: z.string(),
      id: z.string(),
      thinkingLevel: ThinkingLevelSchema.optional(),
    })
    .optional(),
  jsonShape: z.string().optional(),
  updaterPrompt: templatedString({
    variables: ["jsonShape", "updateInstructions"],
  }).optional(),
  updateInstructions: z.string().optional(),
  assistantTextMaxChars: z.number().int().positive().optional(),
  toolResultContentMaxChars: z.number().int().positive().optional(),
  maxToolResults: z.number().int().positive().optional(),
  maxFileEvents: z.number().int().positive().optional(),
});

const config = loadConfigOrDefault({
  filename: "task-context.jsonc",
  schema: ConfigSchema,
  defaults: DEFAULT_OPTIONS,
});

export default taskContext(config);
