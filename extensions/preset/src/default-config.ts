import { loadConfigOrDefault } from "pi-config";
import { type PresetOptions, preset } from "preset";
import { z } from "zod";

const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

const PresetSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  thinkingLevel: ThinkingLevelSchema.optional(),
  tools: z.array(z.string()).optional(),
  instructions: z.string().optional(),
});

const ConfigSchema = z.object({
  presets: z.record(z.string(), PresetSchema).optional(),
  commandName: z.string().optional(),
  flagName: z.string().optional(),
  cycleShortcut: z.union([z.string(), z.literal(false)]).optional(),
  defaultTools: z.array(z.string()).optional(),
  persistState: z.boolean().optional(),
});

const config = loadConfigOrDefault({ filename: "preset.jsonc", schema: ConfigSchema });

export default preset(config as PresetOptions);
