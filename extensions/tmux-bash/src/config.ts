import { loadConfigOrDefault } from "@richardgill/pi-config";
import { resolveOptions, TmuxBashOptionsSchema, type ResolvedOptions } from "./options";

export const TmuxBashConfigSchema = TmuxBashOptionsSchema;

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
    }),
  );
