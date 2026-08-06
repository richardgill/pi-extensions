# pi-extensions

## Extensions (actively used)

- [`pi-background-bash`](./extensions/background-bash/README.md) - Runs session-owned foreground and background process groups with stable logs and automatic completion messages.
- [`pi-context-commands`](./extensions/context-commands/README.md) - Registers slash commands that run commands and put the output into Pi context.
- [`pi-project-resources`](./extensions/project-resources/README.md) - Loads `AGENT.md` and `skills/` by traversing up to `~` from the current folder.
- [`pi-parrot`](./extensions/parrot/README.md) - Populates Pi's input box with the last assistant message.
- [`pi-preset`](./extensions/preset/README.md) - Pi's preset example extension.
- [`pi-up-history`](./extensions/pi-up-history/README.md) - Adds Up-arrow prompt history from saved sessions for the current working directory.
- [`pi-footer`](./extensions/footer/README.md) - Replaces the footer with model, thinking, context, and extension status information.
- [`pi-handoff`](./extensions/handoff/README.md) - Generates an editable context-transfer prompt in a new session.
- [`pi-notify`](./extensions/notify/README.md) - Runs a local beep command after an agent run.
- [`pi-process-info`](./extensions/process-info/README.md) - Records diagnostic process, tmux, session, and agent status entries.
- [`pi-thinking-toggle`](./extensions/thinking-toggle/README.md) - Cycles medium, high, and xhigh thinking levels.
- [`pi-trust-all-projects`](./extensions/trust-all-projects/README.md) - Automatically trusts every project.
- [`@calesennett/pi-codex-fast`](https://www.npmjs.com/package/@calesennett/pi-codex-fast) - Adds the priority service tier to supported OpenAI Codex requests when enabled.
- [`pi-codex-status`](https://github.com/lhl/pi-codex-status) - Shows ChatGPT Codex quota and status information.

## Other extensions

- [`pi-file-collector`](./extensions/file-collector/README.md) - Records files and line ranges that Pi reads, edits, writes, or cites in a JSONL file.
- [`pi-sub-pi`](./extensions/sub-pi/README.md) - Runs isolated Pi subprocesses for single, chained, or parallel tasks.
- [`pi-sub-pi-skill`](./extensions/sub-pi-skill/README.md) - Routes opted-in `/skill:` commands through the `sub-pi` tool.
- [`pi-tmux-bash`](./extensions/tmux-bash/README.md) - Replaces Pi's bash tool with a tmux-backed version for background jobs and polling.

## Packages

- [`pi-config`](./packages/pi-config) - Loads JSONC config files with Zod defaults and templated strings.
- [`pi-zod-tool-call`](./packages/pi-zod-tool-call) - Defines Pi tool calls from Zod schemas with provider-compatible TypeBox parameters.

## Private and unpublished extensions

These packages are intentionally local, have `private: true`, and must not be published to npm.

- [`pi-footer`](./extensions/footer/README.md)
- [`pi-handoff`](./extensions/handoff/README.md)
- [`pi-notify`](./extensions/notify/README.md)
- [`pi-process-info`](./extensions/process-info/README.md)
- [`pi-thinking-toggle`](./extensions/thinking-toggle/README.md)
- [`pi-trust-all-projects`](./extensions/trust-all-projects/README.md)
- [`pi-bash-timeout-guard`](./extensions/bash-timeout-guard/README.md)
- [`pi-task-context`](./extensions/task-context)
