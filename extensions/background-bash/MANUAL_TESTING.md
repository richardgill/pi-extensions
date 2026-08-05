# Manual testing

Run these checks from the repository root. The interactive tmux flow is the authoritative acceptance test because it exercises Pi's TUI, tool rendering, background completion, footer status, and session lifecycle together.

## Automated checks

```bash
pnpm --dir extensions/background-bash test
pnpm --dir extensions/background-bash tsc
pnpm check
```

## Start an interactive test session

```bash
tmux kill-session -t pi-bg-test 2>/dev/null || true
tmux new-session -d -s pi-bg-test -c "$PWD" \
  'timeout 180s pi --no-extensions -e ./extensions/background-bash/src/index.ts'
sleep 2
```

Send prompts literally so shell metacharacters are not interpreted:

```bash
tmux send-keys -t pi-bg-test -l 'PROMPT'
tmux send-keys -t pi-bg-test Enter
sleep 2
tmux capture-pane -p -S - -t pi-bg-test
```

## Foreground behavior

Send:

```text
Call bash with command "printf short-output", timeout 10, and timeoutAction "kill". Do not repeat the log path in your final reply.
```

Verify that `short-output` renders normally and the TUI does not show the stable log path. Also run a command that exits non-zero and confirm its output and exit code are reported.

## Explicit background and completion

Send:

```text
Call bash with command "echo started; sleep 5; echo completed", name "manual-completion", and background true. Do not inspect it afterward.
```

Capture before and after completion:

```bash
sleep 2
tmux capture-pane -p -S - -t pi-bg-test
sleep 5
tmux capture-pane -p -S - -t pi-bg-test
```

Verify:

- the initial result promptly returns a numeric PGID;
- the footer shows `1 background proc` while it runs and clears afterward;
- exactly one automatic completion contains both `started` and `completed`;
- `bash_process list` no longer includes the completed process.

## Timeout handoff

Send:

```text
Call bash with command "echo before; sleep 4; echo after", timeout 1, and timeoutAction "background". Do not inspect it afterward.
```

Verify that `before` appears before handoff, the same PGID continues running, and exactly one later completion contains `after`.

## List, peek, and kill

Send these as separate prompts:

```text
Call bash with command "for i in $(seq 1 300); do date; sleep 1; done", name "ticker", and background true.
```

```text
Call bash_process with action list.
```

```text
Call bash_process with action peek and pgid PGID_FROM_LIST.
```

```text
Call bash_process with action kill and pgid PGID_FROM_LIST.
```

Verify that list and peek return useful process information, kill removes the whole process group, the footer clears, and no automatic completion follows the intentional kill.

From another shell, process-group and log checks can use:

```bash
pgrep -a -g PGID
cat /tmp/pi-background-bash/SESSION_RUN/PGID.log
```

After killing, verify that the group is gone:

```bash
! pgrep -g PGID
```

## Process picker

Start two named `sleep 300` commands with `background: true`, then run `/proc`.

Verify that both processes appear with their name, command, PGID, and elapsed time. Select one, confirm the kill, and verify that the process group is gone, the footer count decreases, and no automatic completion follows the intentional kill. Run `/proc` again and verify that only the remaining process appears.

## Long output

Send:

```text
Call bash with command "for i in $(seq 1 2105); do echo line-$i; done", timeout 10, and timeoutAction "kill". Do not repeat the log path in your final reply.
```

Verify that model-facing output is bounded, the TUI shows one stable full-output path, and the stable log contains both `line-1` and `line-2105`.

## Session cleanup

Start `sleep 300` in the background, record its PGID, then send `/reload`. Verify that the process group is gone and no automatic completion was emitted:

```bash
! pgrep -g PGID
```

Repeat with another `sleep 300`, then exit Pi by killing the tmux harness:

```bash
tmux kill-session -t pi-bg-test
sleep 1
! pgrep -g PGID
```

If a test fails and leaves a process behind, clean it up with:

```bash
kill -KILL -- -PGID
```

## Non-interactive smoke test

```bash
timeout 45s pi --no-extensions \
  -e ./extensions/background-bash/src/index.ts \
  -p 'Call bash with command "printf smoke-ok", timeout 10, and timeoutAction "kill". Reply with only its output.'
```

Expected output: `smoke-ok`.
