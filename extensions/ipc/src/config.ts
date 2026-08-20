import { templatedString } from "@richardgill/pi-config";
import { z } from "zod";

export const DEFAULT_IPC_CONFIG = {
  inspectionCommand: ["pi-jq", "{{childSessionId}}", "--messages", "3"],
  inspectionTimeoutMs: 5000,
  supervisionPrompt: "Continue supervision.",
};

const InspectionArgumentSchema = templatedString({
  variables: ["childSessionId"],
  missing: "keep",
}).min(1);

export const IpcConfigSchema = z
  .object({
    inspectionCommand: z
      .array(InspectionArgumentSchema)
      .min(1)
      .refine(
        (command) =>
          command.reduce(
            (count, argument) => count + argument.split("{{childSessionId}}").length - 1,
            0,
          ) === 1 &&
          command.every((argument) => {
            const untemplated = argument.replaceAll("{{childSessionId}}", "");
            return !untemplated.includes("{{") && !untemplated.includes("}}");
          }),
        "must contain exactly one {{childSessionId}} placeholder and no other templates",
      )
      .default(() => [...DEFAULT_IPC_CONFIG.inspectionCommand]),
    inspectionTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(60_000)
      .default(DEFAULT_IPC_CONFIG.inspectionTimeoutMs),
    supervisionPrompt: z.string().default(DEFAULT_IPC_CONFIG.supervisionPrompt),
  })
  .strict();

export type IpcConfig = z.output<typeof IpcConfigSchema>;
export type IpcConfigInput = z.input<typeof IpcConfigSchema>;
