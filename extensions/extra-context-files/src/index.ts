import { loadConfigOrDefault } from "@richardgill/pi-config";
import { DEFAULT_OPTIONS, extraContextFiles } from "@richardgill/pi-extra-context-files";
import { z } from "zod";

const ConfigSchema = z.object({
  filenames: z.array(z.string()).optional(),
  sectionTitle: z.string().optional(),
});

const config = loadConfigOrDefault({
  filename: "extra-context-files.jsonc",
  schema: ConfigSchema,
  defaults: DEFAULT_OPTIONS,
});

export default extraContextFiles(config);
