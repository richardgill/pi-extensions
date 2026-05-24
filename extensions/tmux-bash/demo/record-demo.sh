#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || realpath "$script_dir/../..")"
output="${1:-$repo_root/overlay/branch/tmux-bash-demo.mp4}"
demo_session="${PI_TMUX_BASH_DEMO_SESSION:-pi-tmux-bash-demo}"
config_dir="$(mktemp -d)"

cleanup() {
  tmux kill-session -t "$demo_session" 2>/dev/null || true
  rm -rf "$config_dir"
}
trap cleanup EXIT

mkdir -p "$(dirname "$output")"
cat > "$config_dir/tmux-bash.jsonc" <<EOF
{
  "globalTmuxSessionName": "$demo_session",
  "tmuxSessionScope": "global"
}
EOF

export PI_EXTENSION_CONFIG_DIR="$config_dir"

nix shell nixpkgs#vhs -c vhs -o "$output" "$script_dir/demo.tape"
printf 'Recorded %s\n' "$output"
