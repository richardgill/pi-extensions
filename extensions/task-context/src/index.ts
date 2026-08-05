import { loadConfigOrDefault, templatedString } from "@richardgill/pi-config";
import { DEFAULT_OPTIONS, taskContext } from "@richardgill/pi-task-context";
import { z } from "zod";

const ThinkingLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);

const CustomCommandSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  title: z.string().optional(),
  maxOutputChars: z.number().int().positive().optional(),
});

const ConfigSchema = z.object({
  outputPath: z.string().default(DEFAULT_OPTIONS.outputPath),
  currentOutputPath: z.union([z.string(), z.literal(false)]).optional(),
  maxSnapshots: z.number().int().positive().default(DEFAULT_OPTIONS.maxSnapshots),
  model: z
    .object({
      provider: z.string().default(DEFAULT_OPTIONS.model.provider),
      id: z.string().default(DEFAULT_OPTIONS.model.id),
      thinkingLevel: ThinkingLevelSchema.default(DEFAULT_OPTIONS.model.thinkingLevel),
    })
    .default(DEFAULT_OPTIONS.model),
  customCommands: z.array(CustomCommandSchema).default(() => [...DEFAULT_OPTIONS.customCommands]),
  jsonShape: z.string().default(DEFAULT_OPTIONS.jsonShape),
  updaterPrompt: templatedString({
    variables: ["jsonShape", "updateInstructions"],
  }).default(DEFAULT_OPTIONS.updaterPrompt),
  updateInstructions: z.string().default(DEFAULT_OPTIONS.updateInstructions),
  assistantTextMaxChars: z.number().int().positive().default(DEFAULT_OPTIONS.assistantTextMaxChars),
  toolResultContentMaxChars: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_OPTIONS.toolResultContentMaxChars),
  maxToolResults: z.number().int().positive().default(DEFAULT_OPTIONS.maxToolResults),
  maxFileEvents: z.number().int().positive().default(DEFAULT_OPTIONS.maxFileEvents),
});

const config = loadConfigOrDefault({
  filename: "task-context.jsonc",
  schema: ConfigSchema,
});

export default taskContext(config);
