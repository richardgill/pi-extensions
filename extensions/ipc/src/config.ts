import { isAbsolute } from "node:path";

import { templatedString } from "@richardgill/pi-config";
import { z } from "zod";

export const DEFAULT_IPC_CONFIG = {
  inspectionCommand: ["pi-jq", "{{childSessionId}}", "--messages", "3", "--role", "assistant"],
  inspectionTimeoutMs: 5000,
  supervisionPrompt: "Continue supervision.",
  liveEventsDir: null,
};

const InspectionArgumentSchema = templatedString({
  variables: ["childSessionId"],
  missing: "keep",
});

const InspectionCommandSchema = z
  .array(InspectionArgumentSchema)
  .min(1)
  .refine(
    (command) =>
      command.reduce(
        (count, argument) => count + argument.split("{{childSessionId}}").length - 1,
        0,
      ) === 1,
    "must contain exactly one {{childSessionId}} placeholder",
  );

const InspectionTimeoutSchema = z.number().int().positive().max(60_000);
const SupervisionPromptSchema = z.string();
const LiveEventsDirSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isAbsolute, "must be an absolute path")
  .nullable();

const ConfigSchema = z
  .object({
    inspectionCommand: InspectionCommandSchema,
    inspectionTimeoutMs: InspectionTimeoutSchema.default(DEFAULT_IPC_CONFIG.inspectionTimeoutMs),
    supervisionPrompt: SupervisionPromptSchema.default(DEFAULT_IPC_CONFIG.supervisionPrompt),
    liveEventsDir: LiveEventsDirSchema.default(DEFAULT_IPC_CONFIG.liveEventsDir),
  })
  .strict();

const DefaultConfigSchema = z
  .object({
    inspectionCommand: z.undefined().optional(),
    inspectionTimeoutMs: InspectionTimeoutSchema.optional(),
    supervisionPrompt: SupervisionPromptSchema.optional(),
    liveEventsDir: LiveEventsDirSchema.optional(),
  })
  .strict()
  .transform((config) => ({
    inspectionCommand: [...DEFAULT_IPC_CONFIG.inspectionCommand],
    inspectionTimeoutMs: config.inspectionTimeoutMs ?? DEFAULT_IPC_CONFIG.inspectionTimeoutMs,
    supervisionPrompt: config.supervisionPrompt ?? DEFAULT_IPC_CONFIG.supervisionPrompt,
    liveEventsDir: config.liveEventsDir ?? DEFAULT_IPC_CONFIG.liveEventsDir,
  }));

export const IpcConfigSchema = z.union([ConfigSchema, DefaultConfigSchema]);

export type IpcConfig = z.output<typeof IpcConfigSchema>;
export type IpcConfigInput = z.input<typeof IpcConfigSchema>;
