# pi-ipc

Lightweight extension that automatically starts or steers a parent model turn when a delegated child finishes. It uses a private Unix socket. It registers no tools or commands.

## Integration

Load `extensions/ipc` in every parent and child Pi through the global Pi `settings.json`. A launcher starts a delegated child with `PI_CHILD=1`, `PI_PARENT_SESSION_ID="$PI_SESSION_ID"`, and `PI_TASK_SLUG=<task-slug>`. `PI_TASK_SLUG` is required whenever `PI_CHILD=1`; it must match `[a-z0-9](?:[a-z0-9-]{0,11}[a-z0-9])?`. Omit `PI_PARENT_SESSION_ID` to disable callbacks. Parent Pi processes do not need a task slug. The extension captures the inherited parent ID and task slug at load time. It derives the parent's short Unix socket path from the ID; no socket path is passed through the environment.

Because the tmux server is an environment boundary, launchers must pass these values explicitly when creating the child. Supervision should react to the model-visible `pi-ipc.delegate-settled` message. Pi runs the configured inspection command, renders its output under `[<task-slug> finished]`, and includes it in model context.

## Configure

Create `ipc.jsonc` in `~/.pi/agent`, or in `$PI_EXTENSION_CONFIG_DIR` when set:

```jsonc
{
  "inspectionCommand": ["pi-jq", "{{childSessionId}}", "--messages", "3", "--role", "assistant"],
  "inspectionTimeoutMs": 5000,
  "supervisionPrompt": "Continue supervision.",
}
```

`inspectionCommand` is executed directly with `pi.exec`, never through a shell. It must contain exactly one `{{childSessionId}}` placeholder. `inspectionTimeoutMs` must be a positive integer no greater than 60000.

When upgrading, remove `liveEventsDir` from `ipc.jsonc` and replace any `PI_DELEGATE*` launcher variables with the ones above.

## Inbound user messages

The per-session private socket also accepts versioned `user_message` requests. `requestId` is required and bounded; retries with the same ID return the original response without delivering twice. Requests have non-empty `message`, `deliverAs: "steer" | "followUp"`, and optional `expandPromptTemplates`, which defaults to `true`.

With the private package installed or linked, send from the command line:

```sh
pi-ipc-send <sessionId> [--after-turn|--follow-up] <message>
printf 'Review the changes.' | pi-ipc-send <sessionId>
```

`--after-turn` is the default and sends a `steer`; `--follow-up` queues until the current agent run finishes. It prints the JSON response and exits nonzero when delivery is unavailable.

Use the exported sender API rather than deriving socket paths:

```ts
import { sendUserMessage } from "./extensions/ipc/src/extension";

const response = await sendUserMessage(sessionId, {
  requestId: crypto.randomUUID(),
  message: "Review the changes.",
  deliverAs: "steer",
});
```

Successful responses include `delivery: "immediate" | "steer" | "followUp"`. Idle sessions deliver immediately; busy sessions use `steer` after the current assistant turn and tools, or `followUp` after the current agent run. Malformed or oversized frames are disconnected without a response. Delegate notifications retain their existing `ACK` response.

## Manual smoke test

From the repository root, load only this extension:

```bash
pi --no-extensions -e ./extensions/ipc/src/index.ts
```

Launch delegated children through tmux with the parent's current Pi session ID, for example `tmux new-session -e PI_CHILD=1 -e PI_PARENT_SESSION_ID="$PI_SESSION_ID" -e PI_TASK_SLUG=review ...`. A delegated child launching a grandchild passes its own `PI_SESSION_ID` the same way. The extension sends a bounded, acknowledged notification once per settled child leaf, deduplicating receipts by the child session ID and leaf ID; a later leaf produces a new notification.
