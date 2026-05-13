import { loadConfigOrDefault } from "@richardgill/pi-config";
import { z } from "zod";
import { tmuxBash, DEFAULT_OPTIONS } from "./extension.js";

const ConfigSchema = z
  .object({
    projectSessionNameTemplate: z.string().includes("{{}}").optional(),
    sessionNameTemplate: z.string().includes("{{}}").optional(),
    sessionScope: z.enum(["project", "shared"]).optional(),
    sharedSessionName: z.string().min(1).optional(),
    toolName: z.string().min(1).optional(),
    commandPrefix: z.string().min(1).optional(),
    captureLines: z.number().int().positive().optional(),
    completionCaptureLines: z.number().int().positive().optional(),
    completionTailLines: z.number().int().positive().optional(),
    windowNameTemplate: z.string().optional(),
    maxWindowNameLength: z.number().int().positive().optional(),
    autoKillIdleOnStartup: z.boolean().optional(),
    autoCloseWindowsOnCompletion: z.boolean().optional(),
    alwaysShowOutputFilePath: z.boolean().optional(),
    preserveOutputFiles: z.boolean().optional(),
    outputDir: z.string().min(1).optional(),
    killSessionOnShutdown: z.boolean().optional(),
    replaceBashTool: z.boolean().optional(),
    defaultTimeoutSeconds: z.number().int().positive().optional(),
    maxTimeoutSeconds: z.number().int().positive().optional(),
    defaultPollInterval: z.number().int().nonnegative().optional(),
    defaultPollLines: z.number().int().positive().optional(),
    displayCommandStartMarker: z.string().optional(),
    prompt: z.string().optional(),
  })
  .refine(
    (config) =>
      config.defaultTimeoutSeconds === undefined ||
      config.maxTimeoutSeconds === undefined ||
      config.defaultTimeoutSeconds <= config.maxTimeoutSeconds,
    "defaultTimeoutSeconds must be less than or equal to maxTimeoutSeconds",
  );

const config = loadConfigOrDefault({
  filename: "tmux-bash.jsonc",
  schema: ConfigSchema,
  defaults: DEFAULT_OPTIONS,
});

export default tmuxBash(config);
