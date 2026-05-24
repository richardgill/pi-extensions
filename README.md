# pi-extensions

## Extensions

- [`pi-extra-context-files`](./extensions/extra-context-files/README.md) — Loads custom named context files such as `AGENTS.local.md` into Pi.
- [`pi-file-collector`](./extensions/file-collector/README.md) — Records files and line ranges that Pi reads, edits, writes, or cites in a JSONL file.
- [`pi-preset`](./extensions/preset/README.md) — Pi’s preset example extension.
- [`pi-sub-pi`](./extensions/sub-pi/README.md) — Pi tool which runs isolated Pi subprocesses for single, chained, or parallel tasks.
- [`pi-sub-pi-skill`](./extensions/sub-pi-skill/README.md) — Routes opted-in `/skill:` commands through the `sub-pi` tool.
- [`pi-tmux-bash`](./extensions/tmux-bash/README.md) — Replaces Pi's bash tool with a tmux-backed version for background jobs and polling.

## Packages

- [`pi-config`](./packages/pi-config) — Loads JSONC config files with Zod defaults and templated strings.
- [`pi-zod-tool-call`](./packages/pi-zod-tool-call) — Defines Pi tool calls from Zod schemas with provider-compatible TypeBox parameters.
