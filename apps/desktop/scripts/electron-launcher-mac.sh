#!/bin/bash
# Wrapper to launch Electron on macOS via the Finder (AppleScript).
#
# On macOS 26 (Darwin 25+), two problems occur with normal dev launch:
#   1. Directly spawning the Electron binary does not initialize the browser
#      process (process.type stays undefined, require("electron") returns a
#      string path instead of the API).
#   2. 'open -n -a App.app' from a detached tmux session (no WindowServer
#      connection) silently fails to launch the app.
#
# Fix:
#   - Embed dev env vars directly into the shim.js inside the app bundle
#     before each launch (reliable; no launchctl propagation needed).
#   - Use 'tell application Finder to open' via osascript to launch the app
#     from the GUI session (works from detached tmux sessions).
#   - Poll until the app process exits (open -W is broken in this context).
#
# electron-vite spawns this script instead of the Electron binary directly.
# Required env vars:
#   HUBBLE_DEV_APP_BUNDLE - path to the .app bundle (set in dev.mjs)
#   ELECTRON_RENDERER_URL - set by electron-vite when renderer dev server starts

set -euo pipefail

APP_BUNDLE="${HUBBLE_DEV_APP_BUNDLE:?'HUBBLE_DEV_APP_BUNDLE not set'}"
EXEC_NAME="$(basename "${APP_BUNDLE%.app}")"
SHIM_PATH="$APP_BUNDLE/Contents/Resources/app/shim.js"
MAIN_PATH="${HUBBLE_DEV_MAIN_PATH:-}"

# Write env vars into the shim so the Electron app receives them on launch.
# (launchctl setenv is unreliable for apps launched via Finder on macOS 26.)
if [ -f "$SHIM_PATH" ] && [ -n "$MAIN_PATH" ]; then
  {
    echo '"use strict";'
    for var in \
      ELECTRON_RENDERER_URL \
      HUBBLE_DESKTOP_FORCE_DEV \
      HUBBLE_DESKTOP_DEV_WORKSPACE \
      HUBBLE_DESKTOP_DEV_APP_NAME \
      HUBBLE_DESKTOP_DEBUG_PORT \
      HUBBLE_DESKTOP_UPDATE_URL \
      HUBBLE_DESKTOP_ENABLE_CDP \
      NODE_ENV_ELECTRON_VITE \
      NODE_ENV; do
      if [ -n "${!var:-}" ]; then
        printf 'process.env[%s] = %s;\n' \
          "$(printf '"%s"' "$var")" \
          "$(printf '"%s"' "${!var}")"
      fi
    done
    printf 'require(%s);\n' "$(printf '"%s"' "$MAIN_PATH")"
  } > "$SHIM_PATH"
fi

# Kill any existing dev app instance before launching a new one.
pkill -x "$EXEC_NAME" 2>/dev/null || true
sleep 0.3

# When electron-vite sends SIGTERM (code change detected, restart requested),
# kill the Electron app so this script exits and electron-vite can respawn.
cleanup() {
  pkill -x "$EXEC_NAME" 2>/dev/null || true
  exit 0
}
trap cleanup SIGTERM SIGINT

# Launch via Finder (AppleScript) — works from detached tmux sessions.
# 'open' from a process without WindowServer access silently fails on macOS 26.
osascript -e "tell application \"Finder\" to open POSIX file \"$APP_BUNDLE\""

# Poll until the Electron process exits.
sleep 2
while pgrep -xq "$EXEC_NAME" 2>/dev/null; do
  sleep 1
done
