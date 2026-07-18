#!/bin/bash
set -euo pipefail

# Builds the optimized, self-contained production desktop app and installs it as
# the daily /Applications/mdly.app. Unlike scripts/install-dev-app.sh, this app
# loads prebuilt renderer assets with no Vite dev server, HMR, or watchers — the
# lean/fast daily-use path.
#
# The app is fully self-contained: every pure-JS main-process dependency is
# bundled into out/ (see apps/desktop/electron.vite.config.ts), so app.asar
# needs no node_modules. This is why the standard signed electron-builder output
# works — earlier "blank window" builds were caused by externalized deps missing
# from the asar, not by signing. It is signed with the machine's Developer ID
# (electron-builder's default); no notarization is required for local use.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="mdly"
RELEASE_APP="$REPO_DIR/apps/desktop/release/mac-arm64/$APP_NAME.app"
INSTALLED_APP="/Applications/$APP_NAME.app"
PNPM="${PNPM:-/Users/trungluong/.nvm/versions/node/v22.22.2/bin/pnpm}"

if [[ ! -x "$PNPM" ]]; then
	PNPM="$(command -v pnpm || true)"
fi

if [[ -z "$PNPM" ]]; then
	echo "[prod-app] pnpm not found. Set PNPM=/path/to/pnpm and try again." >&2
	exit 1
fi

cd "$REPO_DIR"

# 1. Build the desktop workspace and package the arm64 app with default
#    Developer ID signing (electron-vite build -> electron-builder).
"$PNPM" bundle:desktop

if [[ ! -d "$RELEASE_APP" ]]; then
	echo "[prod-app] production build missing: $RELEASE_APP" >&2
	exit 1
fi

# 2. Quit the running app, install over the current daily app, relaunch.
osascript -e 'tell application "mdly" to quit' >/dev/null 2>&1 || true
sleep 1
rm -rf "$INSTALLED_APP"
/usr/bin/ditto "$RELEASE_APP" "$INSTALLED_APP"
/usr/bin/codesign --verify --verbose=2 "$INSTALLED_APP" || true

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
	-f "$INSTALLED_APP"

open "$INSTALLED_APP"

echo "[prod-app] installed and launched $INSTALLED_APP"
