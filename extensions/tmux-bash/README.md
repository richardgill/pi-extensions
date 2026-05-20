# @richardgill/pi-tmux-bash

pi extension which replaces pi's native `bash` tool with background tmux invocations. Provides a `tmux` tool for inspection.

## Tools

- `bash` — run every bash command inside a background tmux window; use `background: true` for long-running commands
- `tmux peek` — capture output from one or all background windows
- `tmux list` — list background windows
- `tmux kill` — kill one background window by stable tmux `#{window_id}` (for example `@123`)
- `tmux poll` — start periodic output check-ins for an existing window
- `tmux unpoll` — stop periodic output check-ins for a window

## Bash tool parameters

```ts
type BashInTmuxInput =
  | {
      command: string;
      name?: string;
      background: true;
      pollInterval?: number;
      pollLines?: number;
    }
  | {
      command: string;
      name?: string;
      background?: false;
      timeout?: number;
      timeoutAction: "background";
      pollInterval?: number;
      pollLines?: number;
    }
  | {
      command: string;
      name?: string;
      background?: false;
      timeout?: number;
      timeoutAction?: "kill";
    };
```

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
  clearIdleBashWindows,
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

// Example:
// const count = clearIdleBashWindows(context);
// // 0
// // or 3, after killing 3 finished bash-created windows
// // or "missing", if the tmux session does not exist
//
// “Idle” means:
// - window was created by tmux-bash
// - pane command is a shell: bash/zsh/sh/fish/dash
// - shell has no child process left
export const clearIdleBashWindows = (context: TmuxBashContext): number | "missing" => {};
```

## Config

Create `~/.pi/agent/tmux-bash.jsonc`:

```jsonc
{
  // Use one global sidecar tmux session, or a per-git-root sidecar session.
  "tmuxSessionScope": "global",

  // Which windows inside the selected tmux session list/peek/kill/poll commands can access.
  "tmuxWindowScope": "pi-session",

  // Template for the background tmux session name when tmuxSessionScope is "git-root".
  // "{{}}" is replaced with the normal git-root session name.
  "gitRootTmuxSessionNameTemplate": "_bg_{{}}",

  // Background tmux session name when tmuxSessionScope is "global".
  "globalTmuxSessionName": "pi-background",

  // Tool name exposed to the agent. Change if another extension registers "tmux".
  "toolName": "tmux",

  // Number of tmux scrollback lines captured by peek.
  "captureLines": 50,

  // Number of tmux scrollback lines captured when a command completes.
  "completionCaptureLines": 30,

  // Number of non-empty completion lines sent back after trimming.
  "completionTailLines": 20,

  // Number of peek output lines shown while collapsed in the TUI.
  "peekPreviewLines": 5,

  // Template for created tmux window names.
  // Supports {{nameOrCommand}}, {{name}}, and {{command}}.
  "windowNameTemplate": "bg: {{nameOrCommand}}",

  // Maximum tmux window name length.
  "maxWindowNameLength": 30,

  // Kill idle finished-command windows when the extension starts.
  "autoKillIdleOnStartup": false,

  // Kill tmux windows after command output has been captured/reported.
  "autoCloseWindowsOnCompletion": true,

  // Show the .out file path even when output is not truncated.
  // This is automatically treated as true when autoCloseWindowsOnCompletion is true.
  "alwaysShowOutputFilePath": false,

  // Keep .out files on pi shutdown instead of deleting the signal/output dir.
  "preserveOutputFiles": false,

  // Base directory for per-session signal files, generated scripts, and .out files.
  "outputDir": "/tmp/pi-tmux-bash",

  // Kill the whole background tmux session when pi exits/reloads.
  // Usually false: preserving background jobs is the point.
  "killSessionOnShutdown": false,

  // Replace the built-in bash tool so every bash call runs inside tmux.
  "replaceBashTool": true,

  // Default seconds to wait for bash-in-tmux before applying timeoutAction.
  "defaultTimeoutSeconds": 30,

  // Maximum accepted bash-in-tmux timeout. Larger timeout values are clamped.
  "maxTimeoutSeconds": 60,

  // Default seconds between automatic poll check-ins. 0 disables default polling.
  "defaultPollInterval": 0,

  // Default tmux scrollback lines captured per poll.
  "defaultPollLines": 30,

  // Maximum output lines kept for model context and expanded TUI cards.
  "maxOutputLines": 2000,

  // Maximum output bytes kept for model context and expanded TUI cards.
  "maxOutputBytes": 51200,

  // Marker used to hide wrapper/shim code from displayed command names/output.
  // Set to "" to disable. Uses the last marker when multiple wrappers are present.
  "displayCommandStartMarker": "# SHIM_END",

  // Extra prompt guidance appended to the bash and tmux tool instructions.
  "prompt": "Use bash with timeoutAction background for dev servers and watchers."
}
```


It is based on [`pi-tmux`](https://github.com/indigoviolet/pi-tmux), but runs agent commands in sidecar tmux sessions instead of the user's normal tmux session. By default it uses one global background tmux session and filters visible windows to the current Pi session.

## Credits

Credit to [`indigoviolet/pi-tmux`](https://github.com/indigoviolet/pi-tmux), which this extension is based on.

