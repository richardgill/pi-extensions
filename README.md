# pi-extensions

## Extensions

### [`@richardgill/pi-extra-context-files`](./extensions/extra-context-files/README.md)

Loads custom named context files such as `AGENTS.local.md` to Pi’s prompt.

### [`@richardgill/pi-file-collector`](./extensions/file-collector/README.md)

Records files and line ranges that Pi reads, edits, writes, or cites in a JSONL file.

### [`@richardgill/pi-preset`](./extensions/preset/README.md)

Pi’s preset example extension.

### [`@richardgill/pi-sub-pi`](./extensions/sub-pi/README.md)

Pi tool which runs isolated Pi subprocesses for single, chained, or parallel tasks.

### [`@richardgill/pi-sub-pi-skill`](./extensions/sub-pi-skill/README.md)

Routes opted-in `/skill:` commands through the `sub-pi` tool.

### [`@richardgill/pi-tmux-bash`](./extensions/tmux-bash/README.md)

Replaces Pi's bash tool with a tmux-backed version for background jobs and polling.

## Packages

### [`@richardgill/lib`](./packages/lib)

Small shared utilities used by the extensions.

### [`@richardgill/pi-config`](./packages/pi-config)

Loads JSONC config files with Zod defaults and templated strings.

### [`@richardgill/pi-zod-tool-call`](./packages/pi-zod-tool-call)

Defines Pi tool calls from Zod schemas with provider-compatible TypeBox parameters.
