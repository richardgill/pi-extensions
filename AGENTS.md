# Extension Testing

## Private extensions

Some extension workspaces are intentionally local and unpublished. Their `package.json` files have `private: true`; do not publish them, remove that safeguard, or assume every extension has a corresponding npm package. Load private extensions directly from this repository.

## Test with -p (non-interactive)

From the repo root:

```bash
pi --no-extensions -e ./extensions/sub-pi/src/index.ts -p "Ping"
```

Expected: `Pong. How can I help?`

## Test without -p (interactive via tmux)

From the repo root, start pi in a detached tmux session with a timeout:

```bash
tmux new-session -d -s pi-ext-test "cd /home/rich/code/pi-extensions && timeout 12s pi --no-extensions -e ./extensions/sub-pi/src/index.ts"
```

Send `2+2` and Enter, then capture the pane to confirm `4`:

```bash
sleep 2
tmux send-keys -t pi-ext-test "2+2" C-m
sleep 2
tmux capture-pane -pt pi-ext-test
```

Clean up:

```bash
tmux kill-session -t pi-ext-test
```
