# @richardgill/pi-tmux-bash

Drop-in pi `bash` tool replacement which uses background tmux.

## How it works

- Foreground `bash` timeouts keep running in background (or kill)
- Background `bash` sends a follow-up result when the command finishes.
- Model can enable polling to receive periodic updates on background output.
- Model can `tmux:peek` to see latest background output.
- Model can `tmux:kill` to kill managed tmux windows.
- Output matches pi's built-in `bash` tool (enforced with e2e parity tests)


## `bash` tool

Runs all bash commands in a tmux window. If a foreground bash command hits a timeout, either leave it running in the background or kill it.

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

The `tmux` tool allows the model to inspect running bash processes.

### List background windows.

```jsonc
{ "action": "list" }
```

### List windows with active periodic check-ins.

```jsonc
{ "action": "list-polls" }
```

### Capture output from one window.

```jsonc
{ "action": "peek", "window": "@123" }
```

### Kill one window by stable tmux `#{window_id}`.

```jsonc
{ "action": "kill", "window": "@123" }
```

### Start periodic output check-ins for a window.

```jsonc
{ "action": "poll", "window": "@123", "pollInterval": 10, "pollLines": 40 }
```

### Stop periodic output check-ins for a window.

```jsonc
{ "action": "unpoll", "window": "@123" }
```

## Config

Create `~/.pi/agent/tmux-bash.jsonc`:


Default config settings:
```jsonc
{
  // ─────────────────────────────────────────────────────────────
  // Bash tool behavior
  // ─────────────────────────────────────────────────────────────

  // Default seconds to wait for bash-in-tmux before applying timeoutAction.
  "defaultTimeoutSeconds": 30,

  // Default action when a foreground bash command hits timeout.
  "defaultTimeoutAction": "background", // "background" (default) | "kill"

  // Maximum accepted bash-in-tmux timeout. Values larger than max are clamped.
  "maxTimeoutSeconds": 60,

  // Milliseconds between streaming foreground bash output updates.
  "foregroundBashUpdateIntervalMs": 250,

  // ─────────────────────────────────────────────────────────────
  // System prompt customization
  // ─────────────────────────────────────────────────────────────

  // Bash tool name exposed to the agent. Change if another extension registers "bash".
  "bashToolName": "bash",

  // Tmux inspection/control tool name exposed to the agent.
  "tmuxToolName": "tmux",

  // Template variables:
  // `{{bashTool}}`: configured with `bashToolName`, default `bash`
  // `{{tmuxTool}}`: configured with `tmuxToolName`, default `tmux`
  // `{{attachCommand}}`:
  //   Uses `tmux switch-client -t @123` when Pi is already inside tmux. Otherwise `tmux attach -t @123`.
  //   Uses configured `tmuxBinary`.
  // `{{defaultTimeoutSeconds}}` / `{{defaultTimeoutAction}}` / `{{maxTimeoutSeconds}}`
  // `{{bashContextLines}}` / `{{maxOutputKb}}`

  // Bash tool description sent to the model tool schema.
  // Supports the same template variables as systemPromptGuidelines below.
  "bashToolDescription": "Execute a bash command in a background tmux window. Output is truncated to last {{bashContextLines}} lines or {{maxOutputKb}}KB. Defaults to a {{defaultTimeoutSeconds}}s timeout, max {{maxTimeoutSeconds}}s; timeoutAction defaults to \"{{defaultTimeoutAction}}\". Use background for long-running commands.",

  // Tmux tool description sent to the model tool schema.
  // Supports the same template variables as systemPromptGuidelines below.
  "tmuxToolDescription": "Inspect and control background tmux windows created by bash.",

  // Controls whether tmux-bash contributes to Pi's generated system prompt.
  // This does not replace Pi's whole system prompt; use Pi's SYSTEM.md or
  // --system-prompt for full prompt replacement.
  // Set to false to omit all tmux-bash Available tools entries and guidelines.
  "systemPrompt": true,

  // Tool snippets for Pi's generated system prompt Available tools section.
  "bashSystemPromptSnippet": "Execute bash commands in background tmux windows", // string | false (to disable)
  "tmuxSystemPromptSnippet": "Inspect and control the background tmux sessions created by bash tool", // string | false (to disable)

  // Guideline bullets appended to Pi's generated system prompt:
  //   Omit systemPromptGuidelines to use defaults.
  //   [] to disable tmux-bash guidelines.
  "systemPromptGuidelines": [ // string[]
    "Use {{bashTool}} with background: true or timeoutAction: \"background\" for long-running commands, servers, watchers, REPLs, interactive prompts, and background bash commands.",
    "Background bash commands will report automatically when they finish.",
    "Set pollInterval only when periodic progress updates are useful or if asked to watch or poll something.",
    "Use {{tmuxTool}} list to find background windows and their stable #{window_id} values like @123.",
    "Use {{tmuxTool}} peek/kill/poll/unpoll with a stable #{window_id} like @123.",
    "If asked, you can attach to tmux window using: {{attachCommand}}, where @123 is a #{window_id}.",
    "Use {{tmuxTool}} poll/unpoll to start or stop periodic check-ins for an existing background window."
  ],

  // ─────────────────────────────────────────────────────────────
  // Tmux settings
  // ─────────────────────────────────────────────────────────────

  // Use a global tmux session, or a per-git-root tmux session.
  "tmuxSessionScope": "global", // "global" (default) | "git-root"

  // Which windows inside the selected tmux session list/peek/kill/poll commands can access.
  "tmuxWindowScope": "pi-session", // "pi-session" (default) | "git-root" | "all"

  // Background tmux session name when tmuxSessionScope is "global".
  "globalTmuxSessionName": "pi-background",

  // Template for the background tmux session name when tmuxSessionScope is "git-root".
  // "{{gitRootSessionName}}" is replaced with the normal git-root session name.
  "gitRootTmuxSessionNameTemplate": "{{gitRootSessionName}}-bg",

  // Template for created tmux window names.
  // Supports {{nameOrCommand}}, {{name}}, and {{command}}.
  "tmuxWindowNameTemplate": "{{nameOrCommand}}",

  // Maximum tmux window name length.
  "maxTmuxWindowNameLength": 30,

  // Kill tmux windows after command completes.
  "autoCloseWindowsOnCompletion": true, // true (default) | false

  // tmux binary/path used for all tmux invocations.
  "tmuxBinary": "tmux",

  // ─────────────────────────────────────────────────────────────
  // Polling and output limits
  // ─────────────────────────────────────────────────────────────

  // Default seconds between automatic poll check-ins. 0 disables default polling.
  "defaultPollInterval": 0,

  // Whether poll cards trigger model turns or display only in the TUI.
  "pollDelivery": "model", // "model" (default) | "display"

  // Minimum seconds between model-delivered poll turns. Does not throttle display-only polls.
  "minimumPollIntervalSeconds": 10,

  // Maximum output bytes kept for model context and TUI cards.
  "maxOutputBytes": 51200,

  // Foreground bash output lines sent to model context.
  "bashContextLines": 2000,

  // Completed background command lines sent to model context.
  "completedContextLines": 20,

  // Poll output lines sent to model context.
  "pollContextLines": 30,

  // Peek output lines sent to model context.
  "peekContextLines": 2000,

  // Foreground bash output lines shown in compact TUI cards.
  "bashCompactDisplayLines": 5,

  // Foreground bash output lines shown in compact TUI cards when output is truncated.
  "bashTruncatedCompactDisplayLines": 2,

  // Foreground bash output lines shown in expanded/uncompacted TUI cards.
  "bashExpandedDisplayLines": 2000,

  // Completed background command lines shown in compact TUI cards.
  "completedCompactDisplayLines": 5,

  // Completed background command lines shown in compact TUI cards when output is truncated.
  "completedTruncatedCompactDisplayLines": 2,

  // Completed background command lines shown in expanded/uncompacted TUI cards.
  "completedExpandedDisplayLines": 20,

  // Poll output lines shown in compact TUI cards.
  "pollCompactDisplayLines": 5,

  // Poll output lines shown in compact TUI cards when output is truncated.
  "pollTruncatedCompactDisplayLines": 2,

  // Poll output lines shown in expanded/uncompacted TUI cards.
  "pollExpandedDisplayLines": 30,

  // Peek output lines shown in compact TUI cards.
  "peekCompactDisplayLines": 5,

  // Peek output lines shown in compact TUI cards when output is truncated.
  "peekTruncatedCompactDisplayLines": 2,

  // Peek output lines shown in expanded/uncompacted TUI cards.
  "peekExpandedDisplayLines": 2000,

  // ─────────────────────────────────────────────────────────────
  // Advanced settings
  // ─────────────────────────────────────────────────────────────

  // Marker used to hide wrapper/shim code from displayed command names/output.
  // Set to "" to disable. Uses the last marker when multiple wrappers are present.
  "displayCommandStartMarker": "# SHIM_END", // use "" to disable

  // Show the .out file path even when output is not truncated.
  "alwaysShowOutputFilePath": false, // true | false (default)

  // Keep .out files on pi shutdown instead of deleting the signal/output dir.
  "preserveOutputFiles": true, // true (default) | false

  // Base directory for per-session signal files, generated scripts, and .out files.
  "outputDir": "/tmp/pi-tmux-bash",

  // Environment names not exported from Pi into bash-in-tmux scripts.
  // Skips shell/tmux bookkeeping that should be owned by the new tmux window.
  "tmuxEnvExportDenylist": ["PWD", "OLDPWD", "SHLVL", "_", "TMUX", "TMUX_PANE"]
}
```

## API helpers

Other extensions can import tmux-bash helpers to target the same background tmux sessions and scoped windows.

```ts
import { loadTmuxBashConfig, type ResolvedOptions } from "@richardgill/pi-tmux-bash/core";

// Example:
// const options = loadTmuxBashConfig();
//
// Reads ~/.pi/agent/tmux-bash.jsonc with the same schema as the extension entrypoint.
export const loadTmuxBashConfig = (): ResolvedOptions => {};
```

```ts
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  listBashWindows,
  resolveTmuxBashContext,
  type TmuxBashContext,
  type TmuxWindow,
  type TmuxWindowFilters,
  type ResolvedOptions,
} from "@richardgill/pi-tmux-bash/core";

export type TmuxBashContext = {
  gitRoot: string;
  session: string;
  filters: TmuxWindowFilters;
  tmuxBinary: string;
};

// Example:
// const options = loadTmuxBashConfig();
// const context = resolveTmuxBashContext(ctx, options);
// if (!context) ctx.ui.notify("Not in a git repository.", "error");
//
// Resolves:
// - current git root
// - tmux session name from config
// - window filters from config
export const resolveTmuxBashContext = (
  ctx: ExtensionContext,
  options: ResolvedOptions,
): TmuxBashContext | null => {};

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

