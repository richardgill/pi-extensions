import { loadConfigOrDefault, templatedString } from "@richardgill/pi-config";
import { z } from "zod";
import { bashTimeoutGuard, DEFAULT_OPTIONS } from "pi-bash-timeout-guard";

const ConfigSchema = z
  .object({
    defaultTimeoutSeconds: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_OPTIONS.defaultTimeoutSeconds),
    maxTimeoutSeconds: z.number().int().positive().default(DEFAULT_OPTIONS.maxTimeoutSeconds),
    prompt: templatedString({
      variables: ["defaultTimeoutSeconds", "maxTimeoutSeconds"],
    }).default(DEFAULT_OPTIONS.prompt),
  })
  .refine(
    (config) =>
      config.defaultTimeoutSeconds === undefined ||
      config.maxTimeoutSeconds === undefined ||
      config.defaultTimeoutSeconds <= config.maxTimeoutSeconds,
    "defaultTimeoutSeconds must be less than or equal to maxTimeoutSeconds",
  );

const config = loadConfigOrDefault({
  filename: "bash-timeout-guard.jsonc",
  schema: ConfigSchema,
});

export default bashTimeoutGuard(config);
