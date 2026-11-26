# pi-ipc

Private Pi extension for two local workflows: notify a parent Pi when its child settles, and send a user message to a running Pi by session ID. It uses a private Unix socket and registers no tools or commands.

From this checkout with workspace dependencies installed, load the extension in each Pi you want to reach:

```bash
pi --no-extensions -e ./extensions/ipc
```

To load it by default, add the absolute path to `extensions/ipc` to the `packages` list in Pi's `settings.json`.

## Send a user message

Get the target's `PI_SESSION_ID` from a command run by its `bash` tool, or read the `id` from the first line of its session JSONL file. From the checkout:

```bash
pnpm --silent --filter pi-ipc pi-ipc-send "$session_id" --after-turn 'Review the changes.'
printf 'Summarize the result.\n' | pnpm --silent --filter pi-ipc pi-ipc-send "$session_id" --follow-up
```

If the local package is linked, run `pi-ipc-send <session-id> [--after-turn|--follow-up] [message]` directly. Omit the message argument to read piped stdin. An idle Pi receives the message immediately. A busy Pi receives it after its current assistant turn and tools (`--after-turn`, the default), or after the current agent run (`--follow-up`). Success prints JSON to stdout; rejection or unavailable delivery prints to stderr and exits nonzero.

## Notify a parent when a child settles

Start the parent with the extension loaded, then launch a child from the checkout with the parent's session ID:

```bash
PI_CHILD=1 PI_TASK_SLUG=review PI_PARENT_SESSION_ID="$parent_session_id" \
  pi --no-extensions -e ./extensions/ipc -p 'Review the changes and report findings.'
```

If launched from the parent's `bash` tool, use `PI_PARENT_SESSION_ID="$PI_SESSION_ID"`. `PI_CHILD=1` requires a task slug of 1-13 lowercase letters, digits, or interior hyphens. Omit (or unset) `PI_PARENT_SESSION_ID` to disable callbacks. Keep the child's session persisted so the parent can inspect it. These variables replace the old `PI_DELEGATE*` names, which are no longer read.

The parent records a receipt and sends `[review finished]` with the inspection output to its model. It starts a turn if idle or steers after the current assistant turn and tools if busy. Retries for the same child session and settled leaf are deduplicated. Receipts without a persisted notification replay when the parent reloads or resumes.

## Configure

Optional `ipc.jsonc` in `~/.pi/agent` (or `$PI_EXTENSION_CONFIG_DIR` when set). These are the defaults; `pi-jq` must be on the parent's `PATH` to use the default report:

```jsonc
{
  "inspectionCommand": ["pi-jq", "{{childSessionId}}", "--messages", "3", "--role", "assistant"],
  "inspectionTimeoutMs": 5000,
  "supervisionPrompt": "Continue supervision."
}
```

The command runs without a shell. It must contain exactly one `{{childSessionId}}` placeholder and no other template variables. The timeout must be a positive integer up to 60000 ms. Both Pis use the current user's private `/tmp/pi-ipc-<uid>` socket directory (mode `0700`).

Remove `liveEventsDir` from existing `ipc.jsonc` files. This extension no longer captures live events.
