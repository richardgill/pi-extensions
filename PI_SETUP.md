# My Pi setup

- I use Pi with OpenAI Codex `gpt-5.6-sol` at the High thinking level (OpenAI has a generous policy allowing you to use your own harness)
- My [`AGENTS.md`](https://github.com/richardgill/nix/blob/main/built/ai-agents/pi/AGENTS.md?plain=1) ([template](https://github.com/richardgill/nix/blob/main/flake/modules/home-manager/dot-files/ai-agents/shared/partials/AGENTS.md.hbs?plain=1))
- My Pi [`settings.json`](https://github.com/richardgill/nix/blob/main/out-of-store-config/ai-agents/pi/settings.json)

I only use `AGENTS.md` + skills.

Pi's [philosophy](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) is to keep things simple and not overdo it with bells and whistles.

Jump to [Install all extensions](#install-all-extensions).

## Run bash commands in the background

- Overrides Pi's built-in `bash` tool with a replacement that runs commands in the background.
- Commands taking over 30 seconds move to the background by default.
  - Prevents the agent from getting stuck if it runs `sleep 999999999999` by accident.
- Background processes trigger an LLM turn when they complete.
- See running processes and kill them with `/proc`.

```sh
pi install npm:@richardgill/pi-background-bash
```

[Source and documentation](./extensions/background-bash/README.md)

## Load custom `CLAUDE.md` and `.claude/skills`

- Load custom context files, such as `CLAUDE.md`, `CLAUDE.local.md`, and `AGENTS.local.md`.
- Load custom skill folders, such as `.claude/skills`.
- Traverse parent folders up to `$HOME`, loading context files and skills.

```jsonc
// ~/.pi/agent/extension-config/project-resources.jsonc
{
  "contextFilenames": ["AGENTS.local.md", "CLAUDE.local.md"],
  "contextSectionTitle": "Extra Context Files",
  "skillDirectoryPaths": [".pi/skills", ".claude/skills"]
}
```

For example:

```text
~/code/
├── AGENTS.local.md
└── my-app/
    ├── CLAUDE.local.md
    ├── .pi/skills/review/SKILL.md
    └── packages/api/
        ├── AGENTS.local.md
        └── .claude/skills/database/SKILL.md
```

Starting Pi in `~/code/my-app/packages/api` loads all three instruction files and both skills.

```sh
pi install npm:@richardgill/pi-project-resources
```

[Source and documentation](./extensions/project-resources/README.md)

## Subagents / tasks

Pi is aware of my tmux setup and can spawn new Pi windows and worktrees using the [orchestrate](https://github.com/richardgill/nix/blob/main/built/ai-agents/pi/skills/orchestrate/SKILL.md?plain=1) and [worktree](https://github.com/richardgill/nix/blob/main/built/ai-agents/pi/skills/worktrees/SKILL.md?plain=1) skills.

But if you're looking for "sub agents", check out my [`sub-pi`](./extensions/sub-pi/README.md) and [`sub-pi-skill`](./extensions/sub-pi-skill/README.md) extensions which I used for a long time.

## Up arrow remembers prompts from previous sessions

Pressing the up arrow shows prompts from previous Pi sessions, similar to Claude Code.

```sh
pi install npm:@richardgill/pi-up-history
```

[Source and documentation](./extensions/pi-up-history/README.md)

## Load command output straight into context

Registers slash commands that run commands and put their output into Pi's context.

Example, `/diff` runs `git diff` and immediately populates the context window without an LLM turn.

```sh
pi install npm:@richardgill/pi-context-commands
```

```jsonc
// ~/.pi/agent/extension-config/context-commands.jsonc
{
  "commands": [
    {
      "name": "diff",
      "description": "Load local changes into context",
      "command": "git",
      "commandArgs": ["diff", "HEAD"]
    },
    {
      "name": "pr-diff",
      "description": "Load PR and local changes into context",
      "command": "git",
      "commandArgs": ["diff", "--merge-base", "origin/main"]
    }
  ]
}
```

[Source and documentation](./extensions/context-commands/README.md)

## `pi-bits`: the rest of my personal setup

- A compact footer showing the model, thinking level, context usage, and extension statuses.
- Automatically trust every new folder - bypassing Pi's project trust prompt.

```sh
pi install npm:@richardgill/pi-bits
```

[Source and documentation](./packages/pi-bits/README.md)

## Enable Codex fast mode

Adds OpenAI Codex `/fast` mode.

```sh
pi install npm:@calesennett/pi-codex-fast
```

[Package](https://www.npmjs.com/package/@calesennett/pi-codex-fast)

## View Codex usage

Adds `/codex:status` for viewing OpenAI Codex usage information.

```sh
pi install npm:pi-codex-status
```

[Source and documentation](https://github.com/lhl/pi-codex-status)

## Install all extensions

```sh
pi install npm:@richardgill/pi-bits
pi install npm:@richardgill/pi-background-bash
pi install npm:@richardgill/pi-context-commands
pi install npm:@richardgill/pi-project-resources
pi install npm:@richardgill/pi-up-history
pi install npm:@calesennett/pi-codex-fast
pi install npm:pi-codex-status
```
