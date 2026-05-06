import { loadConfigOrDefault } from "@richardgill/pi-config";
import { z } from "zod";
import { bashTimeoutGuard, DEFAULT_OPTIONS } from "pi-bash-timeout-guard";

const ConfigSchema = z
  .object({
    defaultTimeoutSeconds: z.number().int().positive().optional(),
    maxTimeoutSeconds: z.number().int().positive().optional(),
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
  filename: "bash-timeout-guard.jsonc",
  schema: ConfigSchema,
  defaults: DEFAULT_OPTIONS,
});

export default bashTimeoutGuard(config);
