#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
if [[ -z "${MODE}" ]]; then
	echo "Usage: $0 [--single|--chained|--parallel]" >&2
	exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "${SCRIPT_DIR}/../.." && pwd)
EXTENSION="${ROOT_DIR}/extensions/task-tool/src/scaffold.ts"

PROVIDER="openai-codex"
MODEL="gpt-5.1-codex-mini"
THINKING="medium"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-}"
HOLD_SECONDS="${HOLD_SECONDS:-5}"
SESSION_NAME="${SESSION_NAME:-pi-ext-test}"
CAPTURE_INTERVAL="${CAPTURE_INTERVAL:-3}"
CAPTURE_COUNT="${CAPTURE_COUNT:-}"
PANE_TARGET="${SESSION_NAME}"

case "${MODE}" in
	--single)
		PROMPT="Use the task tool to run one task: run the bash command sleep 10."
		DEFAULT_TIMEOUT_SECONDS=20
		DEFAULT_CAPTURE_COUNT=7
		;;
	--chained)
		PROMPT="Use the task tool with type chain to run two steps: 1) run the bash command sleep 10; 2) run the bash command sleep 10."
		DEFAULT_TIMEOUT_SECONDS=35
		DEFAULT_CAPTURE_COUNT=10
		;;
	--parallel)
		PROMPT="Use the task tool with type parallel to run two tasks concurrently: run bash commands sleep 10 and sleep 10."
		DEFAULT_TIMEOUT_SECONDS=25
		DEFAULT_CAPTURE_COUNT=9
		;;
	*)
		echo "Usage: $0 [--single|--chained|--parallel]" >&2
		exit 1
		;;
	esac

TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-${DEFAULT_TIMEOUT_SECONDS}}"
CAPTURE_COUNT="${CAPTURE_COUNT:-${DEFAULT_CAPTURE_COUNT}}"

start_session() {
	tmux kill-session -t "${SESSION_NAME}" >/dev/null 2>&1 || true
	tmux new-session -d -s "${SESSION_NAME}" "cd \"${ROOT_DIR}\" && PI_TUI_NO_ALT_SCREEN=1 NO_COLOR=1 timeout ${TIMEOUT_SECONDS}s pi --provider \"${PROVIDER}\" --model \"${MODEL}\" --thinking \"${THINKING}\" --no-extensions -e \"${EXTENSION}\"" >/dev/null
	sleep 1
	tmux send-keys -t "${PANE_TARGET}" "${PROMPT}" C-m >/dev/null 2>&1 || true
}

capture_once() {
	if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
		echo "--- capture ---"
		tmux capture-pane -pt "${PANE_TARGET}" -S -500 || true
	else
		echo "--- session ended ---"
		return 1
	fi
}

start_session
sleep 1
capture_once || true
for _ in $(seq 1 "${CAPTURE_COUNT}"); do
	sleep "${CAPTURE_INTERVAL}" || true
	capture_once || break
done

tmux kill-session -t "${SESSION_NAME}" >/dev/null 2>&1 || true
