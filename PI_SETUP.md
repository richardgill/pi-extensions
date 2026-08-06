# My Pi setup

My Pi setup is deliberately close to vanilla:

- **Provider:** OpenAI Codex · **Model:** `gpt-5.6-sol` · **Thinking level:** High

For reference:

- **Agent instructions:** [`AGENTS.md`](https://github.com/richardgill/nix/blob/main/built/ai-agents/pi/AGENTS.md) ([template](https://github.com/richardgill/nix/blob/main/flake/modules/home-manager/dot-files/ai-agents/pi/AGENTS.md.hbs))
- **Settings:** [`settings.json`](https://github.com/richardgill/nix/blob/main/out-of-store-config/ai-agents/pi/settings.json)

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


## Run bash commands in the background

Overrides the bash tool with one that can run in the background.
Commands taking over 30 seconds move to the background by default, allowing the agent to continue taking turns.

```sh
pi install npm:@richardgill/pi-background-bash
```

[Source and documentation](./extensions/background-bash/README.md)

## Load command output into context

Registers slash commands that run commands and put their output into Pi context.

Example, `/diff` runs `git diff` and immediately populates the context window without an LLM turn.

```sh
pi install npm:@richardgill/pi-context-commands
```

[Source and documentation](./extensions/context-commands/README.md)

My [`context-commands.jsonc`](https://github.com/richardgill/nix/blob/main/out-of-store-config/ai-agents/pi/extension-config/context-commands.jsonc):

```jsonc
{
  "commands": [
    {
      "name": "diff",
      "description": "Load local changes into context",
      "command": "~/Scripts/git-local-diff"
    },
    {
      "name": "pr-diff",
      "description": "Load PR and local changes into context",
      "command": "~/Scripts/git-pr-diff",
      "timeoutMs": 120000
    }
  ]
}
```

## Load project instructions and skills

Loads project instructions and skills by traversing up directories from the current working directory. The default config is:

```jsonc
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

## Reuse prompts from previous sessions

Pressing up arrow shows prompts from previous pi sessions, similar to how Claude Code works.

```sh
pi install npm:@richardgill/pi-up-history
```

[Source and documentation](./extensions/pi-up-history/README.md)

## Add my personal defaults

Bundles my small personal defaults:

- A compact footer showing the model, thinking level, context usage, and extension statuses.
- A Shift+Tab shortcut that cycle through medium, high, and xhigh thinking.
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
