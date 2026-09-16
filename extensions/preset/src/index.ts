import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfigOrDefault } from "@richardgill/pi-config";
import { DEFAULT_OPTIONS, PresetSchema, type PresetOptions, preset } from "@richardgill/pi-preset";
import { z } from "zod";

const ConfigSchema = z.object({
  presets: z.record(z.string(), PresetSchema).default(() => ({ ...DEFAULT_OPTIONS.presets })),
  commandName: z.string().default(DEFAULT_OPTIONS.commandName),
  flagName: z.string().default(DEFAULT_OPTIONS.flagName),
  cycleShortcut: z.union([z.string(), z.literal(false)]).default(DEFAULT_OPTIONS.cycleShortcut),
  defaultTools: z.array(z.string()).default(() => [...DEFAULT_OPTIONS.defaultTools]),
  persistState: z.boolean().default(DEFAULT_OPTIONS.persistState),
});

const configDir = process.env.PI_EXTENSION_CONFIG_DIR ?? getAgentDir();

const config = loadConfigOrDefault({
  folder: configDir,
  filename: "preset.jsonc",
  schema: ConfigSchema,
});

export default preset({ ...config, instructionsBaseDir: configDir } as PresetOptions);
