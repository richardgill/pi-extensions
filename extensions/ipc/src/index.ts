import { loadConfigOrDefault } from "@richardgill/pi-config";

import { IpcConfigSchema } from "./config";
import { ipc } from "./extension";

const config = loadConfigOrDefault({
  filename: "ipc.jsonc",
  schema: IpcConfigSchema,
});

export default (pi: Parameters<typeof ipc>[0]): void => ipc(pi, config);
