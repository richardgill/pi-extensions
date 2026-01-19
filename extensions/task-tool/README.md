# task-tool pi extension

Run isolated `pi` subprocesses for **single**, **chain**, or **parallel** work.

This is similar in spirit to the `subagent/` example, but focuses on running plain prompts (optionally wrapped in a **skill**) without managing agent definitions.

## Features

- **Single, chain, or parallel** task execution
- **Skill wrapping**: matches interactive `/skill:<name> <args>` prompt construction
- **Model inheritance**: defaults to the parent session model (override with `model`)
- **Streaming updates**: see partial progress while subprocesses run
- **Abort support**: Ctrl+C propagates to kill subprocesses

## Install into a project via `~/.pi/agent/extensions/`

Create a project-local extension wrapper:

```bash
mkdir -p ~/.pi/agent/extensions/task-tool
```

Install the plugin:

```bash
cat > ~/.pi/agent/extensions/task-tool/package.json <<'EOF'
{
  "name": "extension-task-tool",
  "private": true,
  "type": "module",
  "dependencies": {
    "task-tool": "github:richardgill/pi-extensions#path:/extensions/task-tool"
  },
  "devDependencies": {
    "@types/node": "^22.13.1"
  }
}
EOF

curl -fsSL https://raw.githubusercontent.com/richardgill/pi-extensions/main/extensions/task-tool/src/scaffold.ts \
  -o ~/.pi/agent/extensions/task-tool/index.ts

(cd ~/.pi/agent/extensions/task-tool && npx pnpm install)
```

Start a fresh `pi`.

### Updating later

```bash
(cd ~/.pi/agent/extensions/task-tool && npx pnpm update task-tool)
```

## Usage

### Single

Tool call shape:

```ts
task({
  type: "single",
  tasks: [{ prompt: "Summarize auth flow" }],
  thinking: "inherit",
});
```

### Single with skill

```ts
task({
  type: "single",
  tasks: [{ skill: "scout", prompt: "Find where auth is handled" }],
});
```

### Parallel

```ts
task({
  type: "parallel",
  thinking: "high",
  tasks: [
    { prompt: "List TODOs in the repo" },
    { skill: "scout", prompt: "Find auth code" },
  ],
});
```

### Chain

Use `{previous}` to reference the prior step output:

```ts
task({
  type: "chain",
  tasks: [
    { prompt: "Find auth flow in the repo" },
    { prompt: "Summarize the auth flow: {previous}" },
  ],
});
```

Limits:
- Max 8 tasks
- Concurrency 4

### Model override

`model` is in `provider/modelId` format:

```ts
task({
  type: "single",
  model: "anthropic/claude-sonnet-4-5",
  tasks: [{ prompt: "Summarize auth flow" }],
});
```

If omitted, the subprocess inherits the parent session model (when available).

### Thinking override

`thinking` accepts `inherit`, `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.

```ts
task({
  type: "single",
  tasks: [{ prompt: "Summarize auth flow" }],
  thinking: "medium",
});
```

If omitted, `thinking` defaults to `inherit`.
