# sub-pi

Run isolated `pi` subprocesses for **single**, **chain**, or **parallel** work.

This is similar in spirit to the `subagent/` example, but focuses on running plain prompts (optionally wrapped in a **skill**) without managing agent definitions.

Part of [`pi-extensions`](../../README.md).

## Features

- **Single, chain, or parallel** task execution
- **Skill wrapping**: matches interactive `/skill:<name> <args>` prompt construction
- **Model inheritance**: defaults to the parent session model (override with `model`)
- **Streaming updates**: see partial progress while subprocesses run
- **Abort support**: Ctrl+C propagates to kill subprocesses

## Install with pi

```bash
pi install git:github.com/richardgill/pi-extensions --extensions +extensions/sub-pi/index.ts
```

## Configure

Create `sub-pi.jsonc` in your pi agent config folder:

```jsonc
{
  "name": "sub-pi",
  "label": "Sub Pi",
  "maxParallelTasks": 8,
  "maxConcurrency": 4,
  "skillListLimit": 30,
  "systemPromptPatches": [
    {
      "match": "\\n\\s*\\n\\s*in addition to the tools above, you may have access to other custom tools depending on the project\\.",
      "flags": "i",
      "replace": "\n- sub-pi: never run this tool unless it's a skill run or I explictly ask you to"
    }
  ]
}
```

## Usage

### Single

```ts
sub-pi({
  type: "single",
  tasks: [{ prompt: "Summarize auth flow" }],
  thinking: "inherit",
});
```

### Single with skill

```ts
sub-pi({
  type: "single",
  tasks: [{ skill: "scout", prompt: "Find where auth is handled" }],
});
```

### Parallel

```ts
sub-pi({
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
sub-pi({
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
sub-pi({
  type: "single",
  model: "anthropic/claude-sonnet-4-5",
  tasks: [{ prompt: "Summarize auth flow" }],
});
```

If omitted, the subprocess inherits the parent session model (when available).

### Thinking override

`thinking` accepts `inherit`, `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.

```ts
sub-pi({
  type: "single",
  tasks: [{ prompt: "Summarize auth flow" }],
  thinking: "medium",
});
```

If omitted, `thinking` defaults to `inherit`.

### Fork context

Each task supports a per-item `fork` boolean (default: `true`). When `fork: true`, the subprocess runs with a temporary session seeded from your current session so session features like `/fork` work.

To keep the old stateless behavior, set `fork: false`:

```ts
sub-pi({
  type: "single",
  tasks: [{ prompt: "Summarize auth flow", fork: false }],
});
```
