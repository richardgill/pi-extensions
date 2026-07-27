import { loadConfigOrDefault } from "@richardgill/pi-config";

import { contextCommands, ContextCommandsConfigSchema } from "./extension";

const config = loadConfigOrDefault({
  filename: "context-commands.jsonc",
  schema: ContextCommandsConfigSchema,
});

export default contextCommands(config);
