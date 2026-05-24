import { loadConfigOrDefault } from "@richardgill/pi-config";
import { DEFAULT_OPTIONS, parrot, type ParrotOptions } from "@richardgill/pi-parrot";
import { z } from "zod";

const ConfigSchema = z.object({
  keyboardShortcut: z
    .union([z.string(), z.literal(false)])
    .default(DEFAULT_OPTIONS.keyboardShortcut),
});

const config = loadConfigOrDefault({
  filename: "parrot.jsonc",
  schema: ConfigSchema,
});

export default parrot(config as ParrotOptions);
