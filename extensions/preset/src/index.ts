import { loadConfigOrDefault } from "@richardgill/pi-config";
import { DEFAULT_OPTIONS, type PresetOptions, preset } from "@richardgill/pi-preset";
import { z } from "zod";

const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const PresetSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  tools: z.array(z.string()).optional(),
  instructions: z.string().optional(),
});

const ConfigSchema = z.object({
  presets: z.record(z.string(), PresetSchema).default(() => ({ ...DEFAULT_OPTIONS.presets })),
  commandName: z.string().default(DEFAULT_OPTIONS.commandName),
  flagName: z.string().default(DEFAULT_OPTIONS.flagName),
  cycleShortcut: z.union([z.string(), z.literal(false)]).default(DEFAULT_OPTIONS.cycleShortcut),
  defaultTools: z.array(z.string()).default(() => [...DEFAULT_OPTIONS.defaultTools]),
  persistState: z.boolean().default(DEFAULT_OPTIONS.persistState),
});

const config = loadConfigOrDefault({
  filename: "preset.jsonc",
  schema: ConfigSchema,
});

export default preset(config as PresetOptions);
