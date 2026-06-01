# @richardgill/pi-up-history

Seeds Pi's native editor history from previous saved sessions for the current working directory.

## Behavior

- On interactive Pi startup, reads existing session JSONL for the current cwd.
- Extracts up to 30 unique non-empty user prompts for the current cwd.
- Seeds the built-in editor history so the normal Up arrow recalls the most recent saved prompt first.
- Wraps any existing custom editor factory instead of replacing it blindly.
- Does not create settings, keybindings, commands, UI, or a separate history file.

## Install

```bash
pi install npm:@richardgill/pi-up-history
```

Development:

```bash
pi --no-extensions -e ./extensions/pi-up-history/src/index.ts
```

## Manual smoke test

Create an isolated Pi data dir and cwd, seed session JSONL, then start Pi in tmux:

```bash
export TEST_PI_DIR=$(mktemp -d)
export TEST_CWD=$(mktemp -d)
SAFE_CWD=$(node -e 'console.log(process.argv[1].replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-"))' "$TEST_CWD")
SESSION_DIR="$TEST_PI_DIR/sessions/--$SAFE_CWD--"
mkdir -p "$SESSION_DIR"
printf '%s\n' \
  '{"type":"session","version":3,"id":"seed","timestamp":"2026-05-26T00:00:00.000Z","cwd":"'"$TEST_CWD"'"}' \
  '{"type":"message","id":"00000001","parentId":null,"timestamp":"2026-05-26T00:00:01.000Z","message":{"role":"user","content":"seeded up-history prompt","timestamp":1790294401000}}' \
  > "$SESSION_DIR/2026-05-26_seed.jsonl"

tmux new-session -d -s pi-up-history-test \
  "cd '$TEST_CWD' && PI_CODING_AGENT_DIR='$TEST_PI_DIR' timeout 12s pi --no-extensions -e /home/rich/code/pi-extensions/pi-up-history/extensions/pi-up-history/src/index.ts"
sleep 2
tmux send-keys -t pi-up-history-test Up
sleep 1
tmux capture-pane -pt pi-up-history-test | grep 'seeded up-history prompt'
tmux kill-session -t pi-up-history-test
```
