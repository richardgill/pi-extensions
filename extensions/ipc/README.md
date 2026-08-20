# pi-ipc

Lightweight extension that automatically starts or steers a parent model turn when a delegated child finishes. It uses a private Unix socket. It registers no tools or commands.

## Integration

Load `extensions/ipc` in every parent and child Pi through the global Pi `settings.json`. A launcher starts a delegated child with `PI_DELEGATE=1`, `PI_DELEGATE_PARENT_SESSION_ID="$PI_SESSION_ID"`, and `PI_DELEGATE_TASK_SLUG=<task-slug>`. `PI_DELEGATE_TASK_SLUG` is required whenever `PI_DELEGATE=1`; it must match `[a-z0-9](?:[a-z0-9-]{0,11}[a-z0-9])?`. Parent Pi processes do not need a task slug. The extension captures the inherited parent ID and task slug at load time. It derives the parent's short Unix socket path from the ID; no socket path is passed through the environment.

Because the tmux server is an environment boundary, launchers must pass these values explicitly when creating the child. Supervision should react to the model-visible `pi-ipc.delegate-settled` message. Pi runs the configured inspection command, renders its output under `[<task-slug> finished]`, and includes it in model context.

## Configure

Create `ipc.jsonc` in `~/.pi/agent`, or in `$PI_EXTENSION_CONFIG_DIR` when set:

```jsonc
{
  "inspectionCommand": ["pi-jq", "{{childSessionId}}", "--messages", "3", "--role", "assistant"],
  "inspectionTimeoutMs": 5000,
  "supervisionPrompt": "Continue supervision.",
  "liveEventsDir": null,
}
```

`inspectionCommand` is executed directly with `pi.exec`, never through a shell. It must contain exactly one `{{childSessionId}}` placeholder. `inspectionTimeoutMs` must be a positive integer no greater than 60000.

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

## Live event stream

Set `liveEventsDir` to an absolute directory to enable the sidecar. It defaults to `null` because the stream contains conversation and tool data and grows without rotation. The directory must be outside Pi's session directory tree.

```jsonc
{
  "liveEventsDir": "/home/me/.local/state/pi-ipc/events",
}
```

Each session runtime writes one append-only stream:

```text
<liveEventsDir>/<sessionId>/<streamId>.jsonl
```

Reloads and session replacements close the old stream and create a new `streamId`. Every complete JSONL record has this envelope:

```json
{
  "version": 1,
  "sessionId": "...",
  "processInstanceId": "<pid>-<uuid>",
  "streamId": "...",
  "sequence": 1,
  "timestamp": 1700000000000,
  "event": { "type": "session_start", "reason": "startup", "cwd": "/project", "pid": 1234 }
}
```

`sequence` starts at 1 and increases within a stream. A tailer should checkpoint `(sessionId, streamId, sequence)` or its byte offset, process only newline-terminated records, and retain an incomplete final line until the next read. `processInstanceId` is stable across extension reloads in one Pi process; `streamId` distinguishes each session runtime.

The stream includes session metadata/compaction/tree events, agent and turn boundaries, message lifecycle events, tool execution start/end, and model/thinking changes. `message_start` and `message_end` contain message snapshots. `message_update` deliberately contains only a compact `assistantMessageEvent`: cumulative `message` and `partial` snapshots plus final block content are omitted, while text, thinking, and tool-call deltas retain `contentIndex`. The complete finalized message remains on `message_end`. Generated `messageId` and `messageSequence` correlate each message lifecycle within the stream.

Writes are serialized and each record is appended with its newline in one operation. Normal event handlers never await filesystem I/O. Shutdown waits for queued records, including `session_shutdown`; a write or serialization failure disables that stream without notifying, blocking, or changing the TUI. The exported `LiveEventRecord`, `CompactAssistantMessageEvent`, `liveEventSessionDir`, and `liveEventStreamPath` APIs are the supported tailer seam.

## Manual smoke test

From the repository root, load only this extension:

```bash
pi --no-extensions -e ./extensions/ipc/src/index.ts
```

Launch delegated children through tmux with the parent's current Pi session ID, for example `tmux new-session -e PI_DELEGATE=1 -e PI_DELEGATE_PARENT_SESSION_ID="$PI_SESSION_ID" -e PI_DELEGATE_TASK_SLUG=<task-slug> ...`. A delegated child launching a grandchild passes its own `PI_SESSION_ID` the same way. The extension sends a bounded, acknowledged notification once per settled child leaf, deduplicating receipts by the child session ID and leaf ID; a later leaf produces a new notification.
