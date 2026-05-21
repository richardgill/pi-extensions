import { loadConfigOrDefault } from "@richardgill/pi-config";
import { z } from "zod";
import { DEFAULT_OPTIONS, type ResolvedOptions } from "./extension.js";

const promptToolEntrySchema = z.union([z.string(), z.literal(false)]);
const promptGuidelinesSchema = z.union([z.array(z.string()), z.literal(false)]);

export const TmuxBashConfigSchema = z
  .object({
    gitRootTmuxSessionNameTemplate: z.string().includes("{gitRootSessionName}").optional(),
    tmuxSessionScope: z.enum(["git-root", "global"]).optional(),
    globalTmuxSessionName: z.string().min(1).optional(),
    tmuxWindowScope: z.enum(["pi-session", "git-root", "all"]).optional(),
    bashToolName: z.string().min(1).optional(),
    tmuxToolName: z.string().min(1).optional(),
    tmuxBinary: z.string().min(1).optional(),
    bashContextLines: z.number().int().positive().optional(),
    bashCompactDisplayLines: z.number().int().positive().optional(),
    bashTruncatedCompactDisplayLines: z.number().int().positive().optional(),
    bashExpandedDisplayLines: z.number().int().positive().optional(),
    completedContextLines: z.number().int().positive().optional(),
    completedCompactDisplayLines: z.number().int().positive().optional(),
    completedTruncatedCompactDisplayLines: z.number().int().positive().optional(),
    completedExpandedDisplayLines: z.number().int().positive().optional(),
    pollContextLines: z.number().int().positive().optional(),
    pollCompactDisplayLines: z.number().int().positive().optional(),
    pollTruncatedCompactDisplayLines: z.number().int().positive().optional(),
    pollExpandedDisplayLines: z.number().int().positive().optional(),
    peekContextLines: z.number().int().positive().optional(),
    peekCompactDisplayLines: z.number().int().positive().optional(),
    peekTruncatedCompactDisplayLines: z.number().int().positive().optional(),
    peekExpandedDisplayLines: z.number().int().positive().optional(),
    windowNameTemplate: z.string().optional(),
    maxWindowNameLength: z.number().int().positive().optional(),
    autoCloseWindowsOnCompletion: z.boolean().optional(),
    alwaysShowOutputFilePath: z.boolean().optional(),
    preserveOutputFiles: z.boolean().optional(),
    outputDir: z.string().min(1).optional(),
    defaultTimeoutSeconds: z.number().int().positive().optional(),
    maxTimeoutSeconds: z.number().int().positive().optional(),
    defaultPollInterval: z.number().int().nonnegative().optional(),
    pollDelivery: z.enum(["model", "display"]).optional(),
    minimumPollIntervalSeconds: z.number().int().positive().optional(),
    displayCommandStartMarker: z.string().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    systemPrompt: z.boolean().optional(),
    systemPromptAvailableTools: z.record(z.string(), promptToolEntrySchema).optional(),
    systemPromptGuidelines: promptGuidelinesSchema.optional(),
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
