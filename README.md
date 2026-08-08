# pi-extensions

> ### [My Pi Setup →](./PI_SETUP.md)


## Extensions (actively used)

### Published on npm
- [`pi-background-bash`](./extensions/background-bash/README.md) - Overrides bash tool with one that can run in the background.
  - By default bash commands which take over 30s go to background and the LLM can continue taking turns.
- [`pi-sub-pi`](./extensions/sub-pi/README.md) - Runs isolated Pi subprocesses for single, chained, or parallel tasks.
- [`pi-sub-pi-skill`](./extensions/sub-pi-skill/README.md) - Routes opted-in `/skill:` commands through the `sub-pi` tool.
- [`pi-context-commands`](./extensions/context-commands/README.md) - Registers slash commands that run commands and put the output into Pi context.
  - Example: `/diff` runs `git diff` and immediately populates context window with 0 LLM turns.
- [`pi-project-resources`](./extensions/project-resources/README.md) - Loads `AGENT.md` and `skills/` by traversing up directories from current working directory until `~`.
  - Allows you to use custom names e.g. `AGENT.local.md`, `CLAUDE.local.md` etc. 
- [`pi-preset`](./extensions/preset/README.md) - Pi's preset example extension but with better config management.
- [`pi-up-history`](./extensions/pi-up-history/README.md) - Adds Up-arrow prompt history from saved sessions for the current working directory.
- [`pi-parrot`](./extensions/parrot/README.md) - Populates Pi's input box with the last assistant message.

### Private extension workspaces

These workspaces are not published individually. Footer and trust-all-projects are distributed through [`@richardgill/pi-bits`](./packages/pi-bits/README.md); thinking-toggle remains local-only.

- [`pi-footer`](./extensions/footer/README.md) - Replaces the footer with model, thinking, context, and extension status information.
- [`pi-trust-all-projects`](./extensions/trust-all-projects/README.md) - Automatically trusts every project.
- [`pi-thinking-toggle`](./extensions/thinking-toggle/README.md) - Cycles medium, high, and xhigh thinking levels.

### 3rd party (not mine)
- [`npm:@calesennett/pi-codex-fast`](https://www.npmjs.com/package/@calesennett/pi-codex-fast) - Adds OpenAI Codex `/fast` mode.
- [`npm:pi-codex-status`](https://github.com/lhl/pi-codex-status) - `/codex:status` shows OpenAI Codex usage info.

## Packages

- [`pi-config`](./packages/pi-config) - Loads JSONC config files with Zod defaults and templated strings.
- [`pi-zod-tool-call`](./packages/pi-zod-tool-call) - Defines Pi tool calls from Zod schemas with provider-compatible TypeBox parameters.

--- 

## Other extensions (not currently used)

### Published on npm

- [`pi-file-collector`](./extensions/file-collector/README.md) - Records files and line ranges that Pi reads, edits, writes, or cites in a JSONL file.
- [`pi-tmux-bash`](./extensions/tmux-bash/README.md) - Replaces Pi's bash tool with a tmux-backed version for background jobs and polling.

### Unpublished

These packages are intentionally local, have `private: true`, and must not be published to npm.

- [`pi-bash-timeout-guard`](./extensions/bash-timeout-guard/README.md)
- [`pi-handoff`](./extensions/handoff/README.md) - Generates an editable context-transfer prompt and opens it in a new session.
- [`pi-task-context`](./extensions/task-context)
