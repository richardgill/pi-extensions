# @richardgill/pi-context-commands

Registers configurable Pi slash commands that run executables and load their output into model context.

## Install

```bash
pi install npm:@richardgill/pi-context-commands
```

Development:

```bash
pi --no-extensions -e ./extensions/context-commands/src/index.ts
```

## Configure

Create `context-commands.jsonc` in `~/.pi/agent`, or in `$PI_EXTENSION_CONFIG_DIR` when set:

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
      "commandArgs": ["--color=never"],
      "title": "PR and local changes",
      "timeoutMs": 120000
    }
  ]
}
```

Each command runs directly in Pi's current working directory without a shell. `commandArgs` are fixed configuration; slash-command arguments are never passed to the process.

Running `/diff` appends stdout and stderr as persistent model-visible context without starting a model turn. Running `/diff review these changes` appends the same context, then sends `review these changes` as the user prompt for one model turn.
