#!/bin/bash
# Starts the Hubble desktop dev server in a named tmux session.
# Safe to run repeatedly — kills any existing session first.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="hubble_desktop_dev"
TMUX_BIN=/usr/local/bin/tmux
# pnpm resolution: $PNPM override, then the Pro default, then PATH, then the
# Air toolchain (the app launcher runs with a minimal PATH, so probe it too).
PNPM="${PNPM:-/Users/trungluong/.nvm/versions/node/v22.22.2/bin/pnpm}"
if [[ ! -x "$PNPM" ]]; then
  PNPM="$(command -v pnpm || true)"
fi
if [[ -z "$PNPM" && -x "$HOME/.local/node-v24.20.0/bin/pnpm" ]]; then
  PNPM="$HOME/.local/node-v24.20.0/bin/pnpm"
fi
if [[ -z "$PNPM" ]]; then
  echo "[launch-dev] pnpm not found. Set PNPM=/path/to/pnpm and try again." >&2
  exit 1
fi
PNPM_DIR="$(dirname "$PNPM")"

# Kill old session if it exists
"$TMUX_BIN" kill-session -t "$SESSION" 2>/dev/null || true
pkill -f "$REPO_DIR/apps/desktop/.dev-electron/.*/Contents/MacOS/.* Dev" 2>/dev/null || true

# Start fresh dev session
"$TMUX_BIN" new-session -d -s "$SESSION" -c "$REPO_DIR" \
  "export PATH=\"$PNPM_DIR:\$PATH\"; \"$PNPM\" dev:desktop; echo '--- process exited ---'; read"

# Open Terminal and attach to the log session
osascript - "$SESSION" <<'APPLESCRIPT'
on run argv
  set sessionName to item 1 of argv
  tell application "Terminal"
    activate
    do script "/usr/local/bin/tmux attach -t " & sessionName
  end tell
end run
APPLESCRIPT
