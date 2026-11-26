# pi-ipc

Private Pi extension for child completion notifications, remote session controls, and optional live event and status files. It uses a private Unix socket and registers no tools or commands.

Runtime ported from [Overmux Pi 0.0.12 at `941f7d91e5eee3e7478dbd10f68e1f6b5da50241`](https://github.com/richardgill/overmux/tree/941f7d91e5eee3e7478dbd10f68e1f6b5da50241/packages/ecosystem/pi).

## Integration

Load the local `extensions/ipc` package in each parent and child Pi, e.g. through the `packages` list in Pi's `settings.json`. Launch a delegated child with `PI_CHILD=1`, `PI_TASK_SLUG=<task-slug>`, and `PI_PARENT_SESSION_ID` set to the parent's `PI_SESSION_ID`. The slug is required when `PI_CHILD=1` and must match `[a-z0-9](?:[a-z0-9-]{0,11}[a-z0-9])?`. Omit `PI_PARENT_SESSION_ID` for a child that should not call back. Top-level parents do not need a slug.

Launchers using tmux must pass these values explicitly to the new process. The extension captures them at load time and derives the parent's socket path from its ID. Sender and receiver must use the same runtime directory, `/tmp/pi-ipc-<uid>` by default (mode `0700`). Programmatic callers can set `runtimeDir` on `ipc(pi, options)` and on the sender helpers.

When a child settles, the parent records a `pi-ipc.delegate-settled-receipt` before acknowledging the notification. The child session ID and leaf ID deduplicate retries. The parent runs the configured inspection command and injects a model-visible `pi-ipc.delegate-settled` message. An idle parent starts a turn; a busy parent gets the message after its current assistant turn and tools. Pi renders the output under `[<task-slug> finished]`. On reload or resume, persisted receipts with no corresponding delivered message are replayed.

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

`inspectionCommand` is executed directly with `pi.exec`, never through a shell. It must contain exactly one `{{childSessionId}}` placeholder, its only permitted template variable. `inspectionTimeoutMs` must be a positive integer no greater than 60000.

## Inbound user messages

The per-session private socket accepts versioned `user_message` requests. `requestId` is required and bounded; retries with a recently completed ID return the cached response without delivering twice. Requests have non-empty `message`, `deliverAs: "steer" | "followUp"`, and optional `expandPromptTemplates`, which defaults to `true` on the wire. The running Pi decides whether to expand templates and dispatch commands. Pi 0.83.0, the repository's type dependency, ignores the flag; 0.84.2 honors it for idle delivery.

With the private package installed or linked, send from the command line:

```sh
pi-ipc-send <sessionId> [--after-turn|--follow-up] <message>
printf 'Review the changes.' | pi-ipc-send <sessionId>
```

`--after-turn` is the default and sends a `steer`; `--follow-up` queues until the current agent run finishes. Without a message argument, the CLI reads from piped stdin. Success prints a JSON response to stdout; rejection or unavailable delivery prints to stderr and exits nonzero. From a workspace checkout, use `pnpm --filter pi-ipc pi-ipc-send <sessionId> ...`.

Use the exported sender API rather than deriving socket paths:

```ts
import { sendUserMessage } from "pi-ipc/protocol";

const response = await sendUserMessage(sessionId, {
  requestId: crypto.randomUUID(),
  message: "Review the changes.",
  deliverAs: "steer",
});
```

Successful responses include `delivery: "immediate" | "steer" | "followUp"`. Idle sessions deliver immediately; busy sessions use `steer` after the current assistant turn and tools, or `followUp` after the current agent run. Malformed or oversized frames are disconnected without a response. Delegate notifications retain their existing `ACK` response.

## Session controls

`pi-ipc/protocol` also exports `probePiSession(sessionId)` for socket availability and `sendAbort`, `sendSetModel`, and `sendSetThinkingLevel` for controlling a session. These are programmatic APIs, not CLI flags.

```ts
import { sendSetModel, sendSetThinkingLevel } from "pi-ipc/protocol";

const result = await sendSetModel(sessionId, {
  requestId: crypto.randomUUID(),
  provider: "anthropic",
  id: "claude-sonnet-4-5",
});
if (result?.ok) {
  await sendSetThinkingLevel(sessionId, { requestId: crypto.randomUUID(), level: "high" });
}
```

Each control returns a versioned response with the request ID and `ok`, or `undefined` when no valid response arrives. Abort requires a busy session. Model selection can fail if the model is not found or lacks credentials. Pi may clamp the requested thinking level to the active model's capabilities.

## Live event stream

Set `liveEventsDir` to an absolute directory to enable the event and status sidecars, files written separately from Pi's session history. The setting defaults to `null` because the stream contains conversation and tool data and grows without rotation. Use a directory outside Pi's session directory tree. Sessions without a persisted session file do not write sidecars.

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

Event writes are queued serially and each record is appended with its newline in one operation. Shutdown waits for queued records, including `session_shutdown`. A write or serialization failure disables that event stream. Use `parseLiveEventRecord`, `LiveEventRecord`, `CompactAssistantMessageEvent`, `liveEventSessionDir`, and `liveEventStreamPath` from the package root when reading the stream.

## Session status

With `liveEventsDir` enabled, each stream also has a versioned snapshot at `<liveEventsDir>/<sessionId>/<streamId>.status.json`. The extension replaces it atomically and records `idle`, `busy`, or `stopped` along with session/process IDs, start and update times, model and thinking settings, and context usage when available. Status is written at startup, before any prompt is needed. A hard crash may leave a snapshot that was not marked `stopped`.

Use `parsePiSessionStatus` to read a raw snapshot or `listPiSessionStatuses({ rootDir: liveEventsDir })` to discover the latest active local streams. The list ignores stopped streams and dead local processes; `createPiSessionStatusSource` adds change notifications. These helpers are available from `pi-ipc/session-status` without loading the Pi extension.

## Manual smoke test

From the repository root, load only this extension:

```bash
pi --no-extensions -e ./extensions/ipc
```

Launch a child through tmux with the parent's current Pi session ID, for example `tmux new-session -e PI_CHILD=1 -e PI_PARENT_SESSION_ID="$PI_SESSION_ID" -e PI_TASK_SLUG=smoke ...`. A child launching a grandchild passes its own `PI_SESSION_ID` the same way. Check that each new settled leaf yields a new notification in the parent.
