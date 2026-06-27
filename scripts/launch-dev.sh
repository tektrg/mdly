#!/bin/bash
# Starts the Hubble desktop dev server in a named tmux session.
# Safe to run repeatedly — kills any existing session first.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="hubble_desktop_dev"
TMUX_BIN=/usr/local/bin/tmux
PNPM=/Users/trungluong/.nvm/versions/node/v22.22.2/bin/pnpm
PNPM_DIR="$(dirname "$PNPM")"

# Kill old session if it exists
"$TMUX_BIN" kill-session -t "$SESSION" 2>/dev/null || true

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
