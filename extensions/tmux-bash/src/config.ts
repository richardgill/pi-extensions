import { loadConfigOrDefault } from "@richardgill/pi-config";
import { z } from "zod";
import { DEFAULT_OPTIONS, type ResolvedOptions } from "./extension.js";

export const TmuxBashConfigSchema = z
  .object({
    gitRootTmuxSessionNameTemplate: z.string().includes("{{}}").optional(),
    tmuxSessionScope: z.enum(["git-root", "global"]).optional(),
    globalTmuxSessionName: z.string().min(1).optional(),
    tmuxWindowScope: z.enum(["pi-session", "git-root", "all"]).optional(),
    toolName: z.string().min(1).optional(),
    captureLines: z.number().int().positive().optional(),
    completionCaptureLines: z.number().int().positive().optional(),
    completionTailLines: z.number().int().positive().optional(),
    peekPreviewLines: z.number().int().positive().optional(),
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
    maxOutputLines: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    prompt: z.string().optional(),
  })
  .refine(
    (config) =>
      config.defaultTimeoutSeconds === undefined ||
      config.maxTimeoutSeconds === undefined ||
      config.defaultTimeoutSeconds <= config.maxTimeoutSeconds,
    "defaultTimeoutSeconds must be less than or equal to maxTimeoutSeconds",
  );

// Example:
// const options = loadTmuxBashConfig();
//
// Reads ~/.pi/agent/tmux-bash.jsonc with the same schema as the extension entrypoint.
// Falls back to DEFAULT_OPTIONS for omitted config.
// Use this when another extension wants to target the same tmux session/window scope.
export const loadTmuxBashConfig = (): ResolvedOptions =>
  loadConfigOrDefault({
    filename: "tmux-bash.jsonc",
    schema: TmuxBashConfigSchema,
    defaults: DEFAULT_OPTIONS,
  }) as ResolvedOptions;
