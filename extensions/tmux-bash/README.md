# @richardgill/pi-tmux-bash

A pi extension that runs `bash` calls inside background tmux windows and provides a `tmux` tool for inspection.

It is based on `@romansix/pi-tmux`, but runs agent commands in a project-specific background sidecar tmux session named `<project-session>-bg`. That keeps agent-run windows out of the user's normal project tmux session.

## Tools

- `bash` — run every bash command inside a background tmux window; use `background: true` for long-running commands
- `tmux peek` — capture output from one or all background windows
- `tmux list` — list background windows
- `tmux attach` — attach to the background session when you do want to inspect it
- `tmux kill` — kill the background session
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

## Commands

- `/tmux` — attach to the background session
- `/tmux:cat` — bring background tmux output into the conversation
- `/tmux:clear` — kill idle background windows

## Config

Create `~/.pi/agent/tmux-bash.jsonc`:

```jsonc
{
  // Template for the background tmux session name.
  // "{{}}" is replaced with the normal project session name.
  "sessionNameTemplate": "_bg_{{}}",

  // Tool name exposed to the agent. Change if another extension registers "tmux".
  "toolName": "tmux",

  // Slash command prefix. "tmux" creates /tmux, /tmux:cat, /tmux:clear.
  "commandPrefix": "tmux",

  // Number of tmux scrollback lines captured by peek and /tmux:cat.
  "captureLines": 50,

  // Number of tmux scrollback lines captured when a command completes.
  "completionCaptureLines": 30,

  // Number of non-empty completion lines sent back after trimming.
  "completionTailLines": 20,

  // Template for created tmux window names.
  // Supports {{nameOrCommand}}, {{name}}, and {{command}}.
  "windowNameTemplate": "bg: {{nameOrCommand}}",

  // Maximum tmux window name length.
  "maxWindowNameLength": 30,

  // Kill idle finished-command windows when the extension starts.
  "autoKillIdleOnStartup": false,

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

  // Extra prompt guidance appended to the bash and tmux tool instructions.
  "prompt": "Use bash with timeoutAction background for dev servers and watchers."
}
```
