# pi-background-bash

A Pi extension that replaces `bash` with session-owned local process groups and adds `bash_process` for listing, inspecting, and killing background commands.

## Install

```bash
pi install npm:@richardgill/pi-background-bash
```

Try the repository checkout without installing:

```bash
pi --no-extensions -e ./extensions/background-bash/src/index.ts
```

The default model tools are `bash` and `bash_process`.

## `bash`

```ts
type BashInput = {
  command: string;
  name?: string;
  background?: boolean;
  timeout?: number;
  timeoutAction?: "background" | "kill";
};
```

Foreground commands stream and truncate output using Pi's standard 50KB/2000-line behavior. Every command also writes a stable combined stdout/stderr log. The model always receives the path, while the TUI only shows it when output is truncated.

Commands honor Pi's effective `shellPath` and `shellCommandPrefix` settings, including trusted project overrides.

`timeout` defaults to 30 seconds, is capped at 60 seconds by default, and must be a positive whole number. The default `timeoutAction` is `"background"`:

- `background: true` returns the PGID immediately and ignores timeout fields.
- `timeoutAction: "background"` hands the same process into the background when the timeout expires.
- `timeoutAction: "kill"` immediately kills the whole process group on timeout.
- Escape kills a foreground process group. After background handoff, the original turn no longer controls it.

Examples:

```text
Call bash with command "pnpm dev", name "dev-server", and background true.
Call bash with command "pnpm test", timeout 30, and timeoutAction "kill".
```

A naturally completed background process sends one follow-up message and wakes the model whether it succeeded or failed. Intentional `bash_process kill` and session shutdown do not send a completion message.

## `bash_process`

```ts
type BashProcessInput =
  | { action: "list" }
  | { action: "peek"; pgid: number }
  | { action: "kill"; pgid: number };
```

Examples:

```text
Call bash_process with action list.
Call bash_process with action peek and pgid 23147.
Call bash_process with action kill and pgid 23147.
```

- `list` returns active background processes with their PGID, name, command, and elapsed time.
- `peek` returns the latest bounded output snapshot without consuming it.
- `kill` immediately kills the process group, waits for output and the log to flush, and suppresses automatic completion.

Completed records are not retained. Completion messages in the Pi transcript are the history.

Active background processes are shown in Pi's footer as `1 background proc`, `2 background procs`, and so on. The status is cleared when the final process exits or is stopped.

Run `/proc` to select an active background process. Press Enter to view its latest log output; the log view refreshes while the process runs and Esc returns to the process list. Press Ctrl+C to request termination of the selected process, then confirm it. The list is a snapshot taken when the command opens; if the process finishes before an action, `/proc` reports that it is no longer active.

Custom footers can read the same preformatted value from Pi's extension statuses:

```ts
const BACKGROUND_BASH_STATUS_KEY = "backgroundBashProcesses";

ctx.ui.setFooter((_tui, theme, footerData) => ({
  invalidate() {},
  render(): string[] {
    const status = footerData.getExtensionStatuses().get(BACKGROUND_BASH_STATUS_KEY) ?? "";
    return [theme.fg("dim", status)];
  },
}));
```

## PGIDs, logs, and cleanup

Commands use detached Unix process groups. The returned PGID is also the shell PID, so long-output results include commands like:

```bash
tail -f /tmp/pi-background-bash/<session-run>/23147.log
pgrep -a -g 23147
kill -KILL -- -23147
```

Prefer `bash_process kill` over raw `kill`. A process killed directly through Linux or macOS is an external termination and may still send its normal automatic completion message.

Logs combine stdout and stderr in arrival order. Relative `outputDir` values resolve from the active session cwd. Run directories use mode `0700`; logs use mode `0600`. `preserveOutputFiles` defaults to `true`, keeping transcript paths useful after Pi exits.

Every `session_shutdown`, including `/reload`, `/new`, `/resume`, `/fork`, and Pi exit, kills all active process groups and waits for their logs to close. A forced `SIGKILL` of Pi cannot run graceful cleanup.

V1 logs are uncapped. A noisy or long-running process can consume unbounded disk space. Remove old logs yourself or set `preserveOutputFiles` to `false` to remove each run directory on graceful shutdown.

## Limitations

V1 supports Linux and macOS. It has no PTY, interactive stdin, attach/reattach, polling subscriptions, persistent process recovery, completed-process registry, or log rotation.

## Configuration

Create `~/.pi/agent/background-bash.jsonc`:

```jsonc
{
  "defaultTimeoutSeconds": 30,
  "defaultTimeoutAction": "background",
  "maxTimeoutSeconds": 60,

  "outputDir": "/tmp/pi-background-bash",
  "preserveOutputFiles": true,

  "bashToolName": "bash",
  "processToolName": "bash_process",

  "bashToolDescription": "Execute a bash command. Output is truncated to Pi's standard limits. Defaults to a {{defaultTimeoutSeconds}}s timeout, max {{maxTimeoutSeconds}}s; timeoutAction defaults to \"{{defaultTimeoutAction}}\". Background processes report automatically when they finish.",
  "processToolDescription": "List, inspect, or kill background processes created by {{bashToolName}}.",

  "systemPrompt": true,
  "bashSystemPromptSnippet": "Execute bash commands with automatic background handoff",
  "processSystemPromptSnippet": "Inspect and control background bash processes",

  "systemPromptGuidelines": [
    "Use {{bashToolName}} with background: true for commands known to be long-running.",
    "{{bashToolName}} commands that exceed their timeout remain running when timeoutAction is \"background\".",
    "You will be notified when background processes finish. No need to sleep to wait.",
    "Use {{processToolName}} list/peek/kill with the PGID returned by {{bashToolName}}."
  ]
}
```

Descriptions, snippets, and guidelines support:

```text
{{bashToolName}}
{{processToolName}}
{{defaultTimeoutSeconds}}
{{defaultTimeoutAction}}
{{maxTimeoutSeconds}}
```

Set either snippet to `false` to omit it. Set `systemPrompt` to `false` to disable both snippets and all guidelines without changing tool descriptions.
