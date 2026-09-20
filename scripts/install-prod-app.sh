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
# Portable pnpm resolution: this script runs on both the MacBook Pro and the
# MacBook Air dev machine, which have different users and node installs.
# Explicit $PNPM wins, then PATH, then known per-machine install locations.
PNPM="${PNPM:-}"
if [[ -z "$PNPM" ]]; then
	PNPM="$(command -v pnpm || true)"
fi
if [[ -z "$PNPM" ]]; then
	for candidate in \
		"$HOME/.local/node-v24.20.0/bin/pnpm" \
		"$HOME/.nvm/versions/node/v22.22.2/bin/pnpm" \
		"/Users/trungluong/.nvm/versions/node/v22.22.2/bin/pnpm"; do
		if [[ -x "$candidate" ]]; then
			PNPM="$candidate"
			break
		fi
	done
fi

if [[ -z "$PNPM" ]]; then
	echo "[prod-app] pnpm not found. Set PNPM=/path/to/pnpm and try again." >&2
	exit 1
fi

cd "$REPO_DIR"

# Two-machine modes (dev happens on the Air, daily app runs on the Pro):
#   BUILD_ONLY=1 — build the release bundle, skip the local install
#                  (push/pull wrappers copy the bundle to the other Mac).
#   SKIP_BUILD=1 — skip the build, install from the existing release bundle
#                  (used after a bundle was copied over from the other Mac).
# Default (neither set) keeps the original behavior: build + install locally.
#
# 1. Build the desktop workspace and package the arm64 app with default
#    Developer ID signing (electron-vite build -> electron-builder).
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
	"$PNPM" bundle:desktop
fi

if [[ ! -d "$RELEASE_APP" ]]; then
	echo "[prod-app] production build missing: $RELEASE_APP" >&2
	exit 1
fi

if [[ "${BUILD_ONLY:-0}" == "1" ]]; then
	echo "[prod-app] built $RELEASE_APP (BUILD_ONLY=1, skipping install)"
	exit 0
fi

# 2. Kill the running app outright, install over the current daily app, relaunch.
#    Never ask it to quit gracefully: quitting tears down every Cloud Sync file
#    watcher on the main thread, which takes minutes on a large workspace
#    (measured 166s on AptusFit) while the window is already gone. For that whole
#    window the dying process still holds Electron's single-instance lock, and an
#    instance that fails to acquire it calls app.quit() before drawing a window or
#    writing a log line -- so the relaunch below would silently do nothing.
#    SIGKILL releases the lock at once. Cost: at most the last ~500ms of typing
#    is lost, the same window a graceful quit already loses (there is no
#    quit-time save).
pkill -9 -x mdly >/dev/null 2>&1 || true

# SIGKILL returns before the kernel has finished reaping, and the lock is only
# free once the process is truly gone. Poll instead of sleeping a fixed guess:
# relaunching into a not-yet-released lock is exactly the silent-exit bug above.
for _ in $(seq 1 50); do
	pgrep -x mdly >/dev/null 2>&1 || break
	sleep 0.2
done
if pgrep -x mdly >/dev/null 2>&1; then
	echo "[prod-app] mdly survived SIGKILL; refusing to relaunch into a held single-instance lock" >&2
	exit 1
fi
rm -rf "$INSTALLED_APP"
/usr/bin/ditto "$RELEASE_APP" "$INSTALLED_APP"
/usr/bin/codesign --verify --verbose=2 "$INSTALLED_APP" || true

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
	-f "$INSTALLED_APP"

open "$INSTALLED_APP" || echo "[prod-app] installed $INSTALLED_APP but relaunch needs a local double-click (no GUI session)"

echo "[prod-app] installed and launched $INSTALLED_APP"
