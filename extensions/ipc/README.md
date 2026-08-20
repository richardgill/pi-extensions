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
}
```

`inspectionCommand` is executed directly with `pi.exec`, never through a shell. It must contain exactly one `{{childSessionId}}` placeholder. `inspectionTimeoutMs` must be a positive integer no greater than 60000.

## Manual smoke test

From the repository root, load only this extension:

```bash
pi --no-extensions -e ./extensions/ipc/src/index.ts
```

Launch delegated children through tmux with the parent's current Pi session ID, for example `tmux new-session -e PI_DELEGATE=1 -e PI_DELEGATE_PARENT_SESSION_ID="$PI_SESSION_ID" -e PI_DELEGATE_TASK_SLUG=<task-slug> ...`. A delegated child launching a grandchild passes its own `PI_SESSION_ID` the same way. The extension sends a bounded, acknowledged notification once per settled child leaf, deduplicating receipts by the child session ID and leaf ID; a later leaf produces a new notification.
