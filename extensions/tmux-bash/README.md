# pi-tmux-bash

Drop-in `bash` replacement that runs commands in the background using tmux.

## Demo

[![tmux-bash demo](https://raw.githubusercontent.com/richardgill/pi-extensions/main/extensions/tmux-bash/demo/demo.webp)](https://github.com/richardgill/pi-extensions/raw/main/extensions/tmux-bash/demo/demo.mp4)

[Watch demo video](https://github.com/richardgill/pi-extensions/raw/main/extensions/tmux-bash/demo/demo.mp4)

## How it works

- All `bash` calls happen inside tmux
- Foreground `bash` timeouts keep running in background (or kill)
- Background `bash` sends a follow-up result when the command finishes.
- Model can enable polling to receive periodic updates on background output.
- Model can `tmux:peek` to see latest background output.
- Model can `tmux:kill` to kill managed tmux windows.
- Output matches pi's built-in `bash` tool (enforced with e2e tests which check against vanilla pi)

## Install 

```bash
pi install npm:@richardgill/pi-tmux-bash
```
Then:

```bash
pi 'Run: for i in $(seq 1 90); do echo "$i"; sleep 1; done. Poll every 10s.'
```

Or try it out without installing:

```bash
pi -e npm:@richardgill/pi-tmux-bash 'Run: for i in $(seq 1 90); do echo "$i"; sleep 1; done. Poll every 10s.'
```

See [Configuration](#configuration) for defaults and overrides.

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

Run a bash command in the background and return immediately, with optional polling for periodic output check-ins.

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

### List background bash tmux windows.

```jsonc
{ "action": "list" }
```

### List tmux windows with polling enabled.

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

You can limit available tmux actions and bash-started polling:

```jsonc
{
  "tmuxEnabledActions": ["peek", "kill"],
  "bashPollIntervalEnabled": false
}
```

## Configuration

You can override individual settings in `tmux-bash.jsonc`.

The default location is `~/.pi/agent/tmux-bash.jsonc`, or `$PI_EXTENSION_CONFIG_DIR/tmux-bash.jsonc` when set.

Default config settings:
```jsonc
{
  // ─────────────────────────────────────────────────────────────
  // Bash tool settings
  // ─────────────────────────────────────────────────────────────

  // Default seconds to wait in foreground bash tool before applying timeoutAction (background or kill).
  "defaultTimeoutSeconds": 30,

  // Default action when a foreground bash command hits timeout.
  "defaultTimeoutAction": "background", // "background" (default) | "kill"

  // Maximum allowed bash-in-tmux timeout; higher values are capped here.
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

  // Tmux actions exposed to the agent. Set [] to disable registering the tmux tool.
  "tmuxEnabledActions": ["list", "peek", "kill"],

  // Whether bash exposes pollInterval/pollLines and can start polling from a bash call.
  "bashPollIntervalEnabled": false,

  // Template variables:
  // `{{bashToolName}}`: configured with `bashToolName`, default `bash`
  // `{{tmuxToolName}}`: configured with `tmuxToolName`, default `tmux`
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

  // modify Pi's built-in system prompt.
  "systemPrompt": true,

  // Tool snippets for Pi's generated system prompt tools section.
  "bashSystemPromptSnippet": "Execute bash commands in background tmux windows", // string | false (to disable)
  "tmuxSystemPromptSnippet": "Inspect and control the background tmux sessions created by bash tool", // string | false (to disable)

  // Guideline bullets appended to Pi's generated system prompt:
  //   Omit systemPromptGuidelines to use defaults.
  //   [] to disable tmux-bash guidelines.
  "systemPromptGuidelines": [
    "Use {{bashToolName}} with background: true or timeoutAction: \"background\" for long-running commands, servers, watchers, REPLs, interactive prompts, and background bash commands.",
    "Background bash commands will report automatically when they finish.",
    "Set pollInterval only when periodic progress updates are useful or if asked to watch or poll something.",
    "Use {{tmuxToolName}} list to find background windows and their stable #{window_id} values like @123.",
    "Use {{tmuxToolName}} peek/kill/poll/unpoll with a stable #{window_id} like @123.",
    "If asked, you can attach to tmux window using: {{attachCommand}}, where @123 is a #{window_id}.",
    "Use {{tmuxToolName}} poll/unpoll to start or stop periodic check-ins for an existing background window."
  ],

  // ─────────────────────────────────────────────────────────────
  // Tmux settings
  // ─────────────────────────────────────────────────────────────

  // Use a global tmux session, or a per-git-root tmux session.
  "tmuxSessionScope": "global", // "global" (default) | "git-root"

  // Background tmux session name when tmuxSessionScope is "global".
  "globalTmuxSessionName": "pi-background",

  // Template for the background tmux session name when tmuxSessionScope is "git-root".
  // "{{gitRootSessionName}}" is replaced with the normal git-root session name.
  "gitRootTmuxSessionNameTemplate": "{{gitRootSessionName}}-bg",

  // Which windows inside the selected tmux session list/peek/kill/poll commands can access.
  "tmuxWindowScope": "pi-session", // "pi-session" (default) | "git-root" | "all"

  // Template for created tmux window names.
  // Supports {{nameOrCommand}}, {{name}}, and {{command}}.
  "tmuxWindowNameTemplate": "{{nameOrCommand}}",

  // Maximum tmux window name length.
  "maxTmuxWindowNameLength": 30,

  // Kill tmux windows after bash command completes.
  "autoCloseWindowsOnCompletion": true, // true (default) | false

  // tmux binary/path used for all tmux invocations.
  "tmuxBinary": "tmux",

  // ─────────────────────────────────────────────────────────────
  // Polling and output limits
  // ─────────────────────────────────────────────────────────────

  // Default seconds between automatic poll check-ins. 0 disables default polling.
  // Ignored by bash calls when bashPollIntervalEnabled is false.
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

  // Hides wrapper/shim lines from the displayed command by showing only lines after the last marker.
  // Set to "" to disable.
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

### `loadTmuxBashConfig`

Reads `tmux-bash.jsonc` from the extension config folder (`PI_EXTENSION_CONFIG_DIR`, then Pi's agent directory).

```ts
import { loadTmuxBashConfig } from "@richardgill/pi-tmux-bash/core";

const options = loadTmuxBashConfig();
```

### `resolveTmuxBashContext`

Resolves the current git root, configured tmux session, and scoped window filters.

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadTmuxBashConfig, resolveTmuxBashContext } from "@richardgill/pi-tmux-bash/core";

const options = loadTmuxBashConfig();
const context = resolveTmuxBashContext(ctx, options);
if (!context) ctx.ui.notify("Not in a git repository.", "error");
```

### `listBashWindows`

Lists bash-created tmux windows matching the resolved scope.

```ts
import { listBashWindows, resolveTmuxBashContext } from "@richardgill/pi-tmux-bash/core";

const options = loadTmuxBashConfig();
const context = resolveTmuxBashContext(ctx, options);
const windows = context ? listBashWindows(context) : [];
// [{ id: "@2172", index: 3, title: "hello-sleep-done", outputFile: "/tmp/..." }]
```

### Read the active background count from footer status

Tmux-bash publishes the active background count with Pi's status API. Footer extensions can read it from `footerData.getExtensionStatuses()` and handle their own string formatting.

```ts
const backgroundBashStatusKey = "backgroundBashTmuxCommands";

const formatBackgroundBashStatus = (value: string) =>
  `${value} background proc${value === "1" ? "" : "s"}`;

ctx.ui.setFooter((_tui, theme, footerData) => ({
  invalidate() {},
  render(width: number): string[] {
    const status = footerData.getExtensionStatuses().get(backgroundBashStatusKey);
    const backgroundBashStatus = status ? formatBackgroundBashStatus(status) : "";

    return [theme.fg("dim", backgroundBashStatus)];
  },
}));
```

The status key is `backgroundBashTmuxCommands`. Status values are strings; tmux-bash clears the status when there are no active background windows.

## Credits

This extension was inspired by [`indigoviolet/pi-tmux`](https://github.com/indigoviolet/pi-tmux).

