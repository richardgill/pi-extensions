# pi-bash-timeout-guard

Overrides Pi's built-in `bash` tool with safer timeouts and stronger guidance to use `tmux` for long-running work.

## Behavior

- Adds a default bash timeout of `30` seconds.
- Clamps requested timeouts to `60` seconds.
- Delegates execution to Pi's built-in `createBashTool(ctx.cwd)`, preserving built-in output/rendering behavior.
- Updates model-visible bash guidance to prefer `tmux` for servers, watchers, REPLs, prompts, and background jobs.

## Install

```bash
pi install ./extensions/bash-timeout-guard
```

Development:

```bash
pi -e ./extensions/bash-timeout-guard/src/index.ts
```

## Configuration

Optional `~/.pi/bash-timeout-guard.jsonc`:

```jsonc
{
  "defaultTimeoutSeconds": 30,
  "maxTimeoutSeconds": 60,
  "prompt": "Never ask bash for more than {{maxTimeoutSeconds}} seconds; use tmux for longer work."
}
```

`defaultTimeoutSeconds` must be less than or equal to `maxTimeoutSeconds`. The optional `prompt` is appended to bash guidelines and supports `{{defaultTimeoutSeconds}}` and `{{maxTimeoutSeconds}}`.

## Usage

After installation, start Pi normally. The package replaces Pi's built-in `bash` tool.

```json
{
  "command": "pnpm test"
}
```

The call above runs with a `30` second timeout. `{ "timeout": 999 }` is clamped to `60` seconds.

Use Pi's `tmux` tool for long-running processes.
