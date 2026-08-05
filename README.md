# pi-extensions

## Extensions (actively used)

- [`pi-background-bash`](./extensions/background-bash/README.md) - Runs session-owned foreground and background process groups with stable logs and automatic completion messages.
- [`pi-context-commands`](./extensions/context-commands/README.md) — Registers slash commands that run commands and put the output into Pi context.
- [`pi-project-resources`](./extensions/project-resources/README.md) — Loads `AGENT.md` and `skills/` by traversing up to `~` from current folder.
- [`pi-parrot`](./extensions/parrot/README.md) — Populates Pi's input box with the last assistant message.
- [`pi-preset`](./extensions/preset/README.md) — Pi’s preset example extension.
- [`pi-up-history`](./extensions/pi-up-history/README.md) — Pi's Up-arrow prompt history from saved sessions for the current working directory.

## Packages

- [`pi-config`](./packages/pi-config) — Loads JSONC config files with Zod defaults and templated strings.
- [`pi-zod-tool-call`](./packages/pi-zod-tool-call) — Defines Pi tool calls from Zod schemas with provider-compatible TypeBox parameters.

## Extensions (old) 

- [`pi-tmux-bash`](./extensions/tmux-bash/README.md) — Replaces Pi's bash tool with a tmux-backed version for background jobs and polling.
- [`pi-sub-pi`](./extensions/sub-pi/README.md) — Pi tool which runs isolated Pi subprocesses for single, chained, or parallel tasks.
- [`pi-sub-pi-skill`](./extensions/sub-pi-skill/README.md) — Routes opted-in `/skill:` commands through the `sub-pi` tool.
- [`pi-file-collector`](./extensions/file-collector/README.md) — Records files and line ranges that Pi reads, edits, writes, or cites in a JSONL file.
