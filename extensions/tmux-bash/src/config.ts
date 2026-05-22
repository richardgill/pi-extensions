import { loadConfigOrDefault, templatedString } from "@richardgill/pi-config";
import { z } from "zod";
import { resolveOptions, type ResolvedOptions } from "./options";

const promptTemplateVariables = [
  "attachCommand",
  "bashContextLines",
  "bashTool",
  "defaultTimeoutSeconds",
  "maxOutputKb",
  "maxTimeoutSeconds",
  "tmuxTool",
];

const gitRootTmuxSessionNameTemplateSchema = templatedString({
  variables: ["gitRootSessionName"],
  missing: "keep",
}).refine(
  (template) => template.includes("{{gitRootSessionName}}"),
  'gitRootTmuxSessionNameTemplate must include "{{gitRootSessionName}}" as the git root session placeholder',
);
const promptTemplateSchema = templatedString({
  variables: promptTemplateVariables,
  missing: "keep",
}).min(1);
const promptToolEntrySchema = z.union([promptTemplateSchema, z.literal(false)]);
const promptGuidelinesSchema = z.union([z.array(promptTemplateSchema), z.literal(false)]);
const windowNameTemplateSchema = templatedString({
  variables: ["command", "name", "nameOrCommand"],
  missing: "keep",
});

export const TmuxBashConfigSchema = z
  .object({
    gitRootTmuxSessionNameTemplate: gitRootTmuxSessionNameTemplateSchema.optional(),
    tmuxSessionScope: z.enum(["git-root", "global"]).optional(),
    globalTmuxSessionName: z.string().min(1).optional(),
    tmuxWindowScope: z.enum(["pi-session", "git-root", "all"]).optional(),
    bashToolName: z.string().min(1).optional(),
    tmuxToolName: z.string().min(1).optional(),
    bashToolDescription: promptTemplateSchema.optional(),
    tmuxToolDescription: promptTemplateSchema.optional(),
    tmuxBinary: z.string().min(1).optional(),
    tmuxEnvExportDenylist: z.array(z.string().min(1)).optional(),
    foregroundBashUpdateIntervalMs: z.number().int().positive().optional(),
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
    windowNameTemplate: windowNameTemplateSchema.optional(),
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
    systemPromptToolSnippets: z.record(z.string(), promptToolEntrySchema).optional(),
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
  resolveOptions(
    loadConfigOrDefault({
      filename: "tmux-bash.jsonc",
      schema: TmuxBashConfigSchema,
      defaults: {},
    }),
  );
