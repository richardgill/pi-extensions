# @richardgill/pi-tmux-bash

pi extension which replaces pi's native `bash` tool with background tmux invocations. Provides a `tmux` tool for inspection.

## `bash` tool

Runs bash commands in a tmux window. If it hits `timeout`, either leave it running in the background or kill it.

```jsonc
{
  "command": "pnpm test",
  "name": "test",
  "timeout": 30,
  "timeoutAction": "background" // or "kill"
}
```

Run a bash command in the background and return immediately, with optional periodic output check-ins.

```jsonc
{
  "command": "pnpm dev",
  "name": "dev-server",
  "background": true,
  "pollInterval": 10,
  "pollLines": 40
}
```

## `tmux` tool

List background windows.

```jsonc
{ "action": "list" }
```

List windows with active periodic check-ins.

```jsonc
{ "action": "list-polls" }
```

Capture output from one window.

```jsonc
{ "action": "peek", "window": "@123" }
```

Kill one window by stable tmux `#{window_id}`.

```jsonc
{ "action": "kill", "window": "@123" }
```

Start periodic output check-ins for a window.

```jsonc
{ "action": "poll", "window": "@123", "pollInterval": 10, "pollLines": 40 }
```

Stop periodic output check-ins for a window.

```jsonc
{ "action": "unpoll", "window": "@123" }
```

## Config

Create `~/.pi/agent/tmux-bash.jsonc`:

```jsonc
{
  // Use a global tmux session, or a per-git-root tmux session.
  "tmuxSessionScope": "global", // "global" (default) | "git-root"

  // Which windows inside the selected tmux session list/peek/kill/poll commands can access.
  "tmuxWindowScope": "pi-session", // "pi-session" (default) | "git-root" | "all"

  // Template for the background tmux session name when tmuxSessionScope is "git-root".
  // "{gitRootSessionName}" is replaced with the normal git-root session name.
  "gitRootTmuxSessionNameTemplate": "{gitRootSessionName}-bg", // default; must include "{gitRootSessionName}"

  // Background tmux session name when tmuxSessionScope is "global".
  "globalTmuxSessionName": "pi-background", // default

  // Tool name exposed to the agent. Change if another extension registers "tmux".
  "toolName": "tmux", // default

  // Foreground bash output lines sent to model context.
  "bashContextLines": 2000, // default; positive integer

  // Foreground bash output lines shown in compact TUI cards.
  "bashCompactDisplayLines": 5, // default; positive integer

  // Foreground bash output lines shown in expanded/uncompacted TUI cards.
  "bashExpandedDisplayLines": 2000, // default; positive integer

  // Completed background command lines sent to model context.
  "completedContextLines": 20, // default; positive integer

  // Completed background command lines shown in compact TUI cards.
  "completedCompactDisplayLines": 5, // default; positive integer

  // Completed background command lines shown in expanded/uncompacted TUI cards.
  "completedExpandedDisplayLines": 20, // default; positive integer

  // Poll output lines sent to model context.
  "pollContextLines": 30, // default; positive integer

  // Poll output lines shown in compact TUI cards.
  "pollCompactDisplayLines": 5, // default; positive integer

  // Poll output lines shown in expanded/uncompacted TUI cards.
  "pollExpandedDisplayLines": 30, // default; positive integer

  // Peek output lines sent to model context.
  "peekContextLines": 2000, // default; positive integer

  // Peek output lines shown in compact TUI cards.
  "peekCompactDisplayLines": 5, // default; positive integer

  // Peek output lines shown in expanded/uncompacted TUI cards.
  "peekExpandedDisplayLines": 2000, // default; positive integer

  // Template for created tmux window names.
  // Supports {{nameOrCommand}}, {{name}}, and {{command}}.
  "windowNameTemplate": "{{nameOrCommand}}", // default

  // Maximum tmux window name length.
  "maxWindowNameLength": 30, // default; positive integer

  // Kill tmux windows after command completes.
  "autoCloseWindowsOnCompletion": true, // true (default) | false

  // Show the .out file path even when output is not truncated.
  "alwaysShowOutputFilePath": false, // true | false (default)

  // Keep .out files on pi shutdown instead of deleting the signal/output dir.
  "preserveOutputFiles": false, // true | false (default)

  // Base directory for per-session signal files, generated scripts, and .out files.
  "outputDir": "/tmp/pi-tmux-bash", // default

  // Kill the whole background tmux session when pi exits/reloads.
  // Usually false: preserving background bash commands is the point.
  "killSessionOnShutdown": false, // true | false (default)

  // Replace the built-in bash tool so every bash call runs inside tmux.
  "replaceBashTool": true, // true (default) | false

  // Default seconds to wait for bash-in-tmux before applying timeoutAction.
  "defaultTimeoutSeconds": 30, // default; positive integer

  // Maximum accepted bash-in-tmux timeout. Larger timeout values are clamped.
  "maxTimeoutSeconds": 60, // default; positive integer

  // Default seconds between automatic poll check-ins. 0 disables default polling.
  "defaultPollInterval": 0, // default; non-negative integer

  // Maximum output bytes kept for model context and TUI cards.
  "maxOutputBytes": 51200, // default; positive integer

  // Marker used to hide wrapper/shim code from displayed command names/output.
  // Set to "" to disable. Uses the last marker when multiple wrappers are present.
  "displayCommandStartMarker": "# SHIM_END", // default; use "" to disable

  // Extra prompt guidance appended to the bash and tmux tool instructions.
  "prompt": "", // default
}
```


It is based on [`pi-tmux`](https://github.com/indigoviolet/pi-tmux), but runs agent commands in sidecar tmux sessions instead of the user's normal tmux session. By default it uses one global background tmux session and filters visible windows to the current Pi session.

## API helpers

Other extensions can import tmux-bash helpers to target the same background tmux sessions and scoped windows.

```ts
import type { ResolvedOptions } from "@richardgill/pi-tmux-bash";
import { loadTmuxBashConfig } from "@richardgill/pi-tmux-bash/config";

// Example:
// const options = loadTmuxBashConfig();
//
// Reads ~/.pi/agent/tmux-bash.jsonc with the same schema as the extension entrypoint.
// Falls back to DEFAULT_OPTIONS for omitted config.
// Use this when another extension wants to target the same tmux session/window scope.
export const loadTmuxBashConfig = (): ResolvedOptions => {};
```

```ts
import {
  listBashWindows,
  resolveTmuxBashContext,
  type TmuxBashContext,
  type TmuxWindow,
  type TmuxWindowFilters,
} from "@richardgill/pi-tmux-bash/core";
import type { ResolvedOptions } from "@richardgill/pi-tmux-bash";

export type TmuxBashContext = {
  gitRoot: string;
  session: string;
  filters: TmuxWindowFilters;
};

// Example:
// const options = loadTmuxBashConfig();
// const context = resolveTmuxBashContext({
//   cwd: ctx.cwd,
//   piSessionId: ctx.sessionManager.getSessionId(),
//   options,
// });
// if (!context) ctx.ui.notify("Not in a git repository.", "error");
//
// Resolves:
// - current git root
// - tmux session name from config
// - window filters from config
export const resolveTmuxBashContext = (input: {
  cwd: string;
  piSessionId: string;
  options: ResolvedOptions;
}): TmuxBashContext | null => {};

// Example:
// const windows = listBashWindows(context);
// // [
// //   { id: "@2172", index: 3, title: "hello-sleep-done", outputFile: "/tmp/..." },
// // ]
//
// Lists only bash-created windows matching the resolved scope.
export const listBashWindows = (context: TmuxBashContext): TmuxWindow[] => {};
```

## Credits

Credit to [`indigoviolet/pi-tmux`](https://github.com/indigoviolet/pi-tmux), which this extension is based on.

