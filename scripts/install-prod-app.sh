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
# RELEASE_APP override: install from a private staging copy (push/pull wrappers
# rsync the bundle into a per-run temp dir, never into a shared release dir).
RELEASE_APP="${RELEASE_APP:-$REPO_DIR/apps/desktop/release/mac-arm64/$APP_NAME.app}"
INSTALLED_APP="${INSTALLED_APP:-/Applications/$APP_NAME.app}"
PREV_APP="$INSTALLED_APP.prev"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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

# Node for the asar check (non-interactive ssh has no node on PATH): next to pnpm.
NODE_BIN="${NODE_BIN:-$(dirname "$PNPM")/node}"
[[ -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"

# ── Ship lock: one prod build/install per machine at a time (2026-11-13: two
#    concurrent ships rewrote release/ under each other -> corrupt app.asar). ──
# shellcheck source=lib/ship-lock.sh
source "$SCRIPT_DIR/lib/ship-lock.sh"
PAUSED_WATCHERS=""
on_exit() {
	local rc=$?
	if [[ -n "$PAUSED_WATCHERS" ]]; then
		kill -CONT $PAUSED_WATCHERS 2>/dev/null || true
		echo "[prod-app] resumed dev watcher(s) $PAUSED_WATCHERS"
	fi
	ship_lock_release
	return $rc
}
trap on_exit EXIT
ship_lock_acquire "install-prod-app $( [[ "${SKIP_BUILD:-0}" == 1 ]] && echo install || echo build) ($(whoami))"

cd "$REPO_DIR"

asar_check() {
	local asar="$1/Contents/Resources/app.asar"
	if [[ -z "$NODE_BIN" ]]; then
		echo "[prod-app] WARNING: no node found; skipping app.asar structure check" >&2
		return 0
	fi
	"$NODE_BIN" "$SCRIPT_DIR/check-app-asar.mjs" "$asar"
}
out_fingerprint() {
	(cd apps/desktop/out && find . -type f -print0 | sort -z | xargs -0 shasum | shasum | cut -c1-40)
}

# Two-machine modes (dev happens on the Air, daily app runs on the Pro):
#   BUILD_ONLY=1 — build the release bundle, skip the local install
#                  (push/pull wrappers copy the bundle to the other Mac).
#                  STAGE_DIR=<dir> also ditto's the built app there under the lock.
#   SKIP_BUILD=1 — skip the build, install from the existing release bundle
#                  (or RELEASE_APP, a staged copy from the other Mac).
# Default (neither set) keeps the original behavior: build + install locally.
#   TEST_STUB_BUILD=<secs> — test hook: sleep instead of building (lock tests).
#
# 1. Build: electron-vite build -> out/, then electron-builder packs out/** into
#    release/. The dev watcher (hubble_desktop_dev tmux: `electron-vite dev
#    --watch`) writes the SAME out/ dir, so it is SIGSTOPped for the build and
#    SIGCONTed on any exit; an out/ fingerprint taken before vs after packing is
#    the backstop.
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
	if [[ -n "${TEST_STUB_BUILD:-}" ]]; then
		echo "[prod-app] TEST_STUB_BUILD: pretending to build for ${TEST_STUB_BUILD}s"
		sleep "$TEST_STUB_BUILD"
		echo "[prod-app] TEST_STUB_BUILD done"
		exit 0
	fi
	PAUSED_WATCHERS="$(ps -axo pid=,command= | grep -F "$REPO_DIR/node_modules/" | grep -E 'electron-vite[^ ]* dev( |$)' | grep -v grep | awk '{print $1}' | xargs || true)"
	if [[ -n "$PAUSED_WATCHERS" ]]; then
		echo "[prod-app] pausing dev watcher(s) $PAUSED_WATCHERS (they write apps/desktop/out) for the build"
		kill -STOP $PAUSED_WATCHERS
	fi
	"$PNPM" --filter "@hubble.md/desktop..." --if-present build
	fp_before="$(out_fingerprint)"
	"$PNPM" --filter @hubble.md/desktop exec electron-builder --mac --arm64
	fp_after="$(out_fingerprint)"
	if [[ "$fp_before" != "$fp_after" ]]; then
		echo "[prod-app] BUILD FAILED: apps/desktop/out changed while electron-builder packed it (a dev watcher or another build wrote into it). Stop it and rebuild." >&2
		exit 1
	fi
	asar_check "$RELEASE_APP" || { echo "[prod-app] BUILD FAILED: freshly built app.asar is corrupt" >&2; exit 1; }
	shasum -a 256 "$RELEASE_APP/Contents/Resources/app.asar" | cut -d' ' -f1 >"$RELEASE_APP/../app.asar.sha256"
fi

if [[ ! -d "$RELEASE_APP" ]]; then
	echo "[prod-app] production build missing: $RELEASE_APP" >&2
	exit 1
fi

if [[ "${BUILD_ONLY:-0}" == "1" ]]; then
	if [[ -n "${STAGE_DIR:-}" ]]; then
		mkdir -p "$STAGE_DIR"
		/usr/bin/ditto "$RELEASE_APP" "$STAGE_DIR/$APP_NAME.app"
		cp "$RELEASE_APP/../app.asar.sha256" "$STAGE_DIR/"
		echo "[prod-app] staged $STAGE_DIR/$APP_NAME.app"
	fi
	echo "[prod-app] built $RELEASE_APP (BUILD_ONLY=1, skipping install)"
	exit 0
fi

# Expected asar sha (written at build time next to the bundle). A copy that
# differs from what was built is refused before the running app is touched.
EXPECTED_SHA="$(cat "$RELEASE_APP/../app.asar.sha256" 2>/dev/null || true)"
check_installed_asar() {
	local app="$1"
	if [[ -n "$EXPECTED_SHA" ]]; then
		local got
		got="$(shasum -a 256 "$app/Contents/Resources/app.asar" | cut -d' ' -f1)"
		if [[ "$got" != "$EXPECTED_SHA" ]]; then
			echo "[prod-app] app.asar sha mismatch in $app: built $EXPECTED_SHA, got $got" >&2
			return 1
		fi
		echo "[prod-app] app.asar sha matches build ($EXPECTED_SHA)"
	else
		echo "[prod-app] WARNING: no app.asar.sha256 next to $RELEASE_APP; structure check only" >&2
	fi
	asar_check "$app"
}
if ! check_installed_asar "$RELEASE_APP"; then
	echo "[prod-app] REFUSING TO INSTALL: bundle to install is corrupt; running app left untouched" >&2
	exit 1
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
MAIN_EXE="$INSTALLED_APP/Contents/MacOS/$APP_NAME"
kill_app() {
	pkill -9 -x "$APP_NAME" >/dev/null 2>&1 || true
	# SIGKILL returns before the kernel has finished reaping, and the lock is only
	# free once the process is truly gone. Poll instead of sleeping a fixed guess.
	for _ in $(seq 1 50); do
		pgrep -x "$APP_NAME" >/dev/null 2>&1 || return 0
		sleep 0.2
	done
	echo "[prod-app] $APP_NAME survived SIGKILL; refusing to relaunch into a held single-instance lock" >&2
	return 1
}
kill_app || exit 1

# Keep the previous bundle so a failed launch check can roll back.
rm -rf "$PREV_APP"
[[ -d "$INSTALLED_APP" ]] && mv "$INSTALLED_APP" "$PREV_APP"
/usr/bin/ditto "$RELEASE_APP" "$INSTALLED_APP"
/usr/bin/codesign --verify --verbose=2 "$INSTALLED_APP" || true

lsreg() {
	/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$1"
}

rollback() {
	echo "[prod-app] !!!!!!!!!! PROD INSTALL FAILED: $1 !!!!!!!!!!" >&2
	kill_app || true
	if [[ -d "$PREV_APP" ]]; then
		rm -rf "$INSTALLED_APP"
		mv "$PREV_APP" "$INSTALLED_APP"
		lsreg "$INSTALLED_APP"
		open "$INSTALLED_APP" || true
		echo "[prod-app] ROLLED BACK to the previous $INSTALLED_APP and relaunched it" >&2
	else
		echo "[prod-app] no previous bundle to roll back to; $INSTALLED_APP is broken" >&2
	fi
	exit 1
}

check_installed_asar "$INSTALLED_APP" || rollback "installed app.asar is corrupt"
lsreg "$INSTALLED_APP"

# Main-process stdout/stderr go to a log for crash diagnostics only. The
# pass/fail signal is the process itself: an empty log is NOT "no crash"
# (a corrupt app.asar exits 1 printing nothing).
LAUNCH_LOG="${TMPDIR:-/tmp}/mdly-prod-launch.log"
: >"$LAUNCH_LOG"
if ! open --env ELECTRON_ENABLE_LOGGING=1 --stdout "$LAUNCH_LOG" --stderr "$LAUNCH_LOG" "$INSTALLED_APP"; then
	if [[ "${ALLOW_NO_LAUNCH:-0}" == "1" ]]; then
		echo "[prod-app] WARNING: installed $INSTALLED_APP but could not launch it (ALLOW_NO_LAUNCH=1); LAUNCH CHECK NOT RUN — double-click it and confirm it opens" >&2
		rm -rf "$PREV_APP"
		exit 0
	fi
	rollback "could not launch $INSTALLED_APP (no GUI session? rerun with ALLOW_NO_LAUNCH=1 to install untested)"
fi

# 3. Launch check (SKIP_LAUNCH_SMOKE=1 opts out): the main process of THIS
#    bundle (matched by its full executable path, not the bare name) must exist
#    within 10s and the SAME pid must still be alive ~18s later. Same pid
#    catches crash-and-relaunch; full path ignores mdly Dev / other copies.
if [[ "${SKIP_LAUNCH_SMOKE:-0}" != "1" ]]; then
	main_pid() { pgrep -f "^$MAIN_EXE\$|^$MAIN_EXE " | head -1; }
	first_pid=""
	for _ in $(seq 1 20); do
		first_pid="$(main_pid || true)"
		[[ -n "$first_pid" ]] && break
		sleep 0.5
	done
	[[ -n "$first_pid" ]] || rollback "main process $MAIN_EXE never started"
	crash_re='Uncaught Exception|A JavaScript error occurred|App threw an error during load'
	for _ in $(seq 1 36); do
		sleep 0.5
		kill -0 "$first_pid" 2>/dev/null || break
		grep -Eq "$crash_re" "$LAUNCH_LOG" 2>/dev/null && break
	done
	if ! kill -0 "$first_pid" 2>/dev/null || grep -Eq "$crash_re" "$LAUNCH_LOG" 2>/dev/null; then
		echo "[prod-app] --- $LAUNCH_LOG (crash excerpt / tail) ---" >&2
		{ grep -En -A15 "$crash_re" "$LAUNCH_LOG" || tail -n 40 "$LAUNCH_LOG"; } | head -n 60 >&2
		rollback "main process (pid $first_pid) died within ~18s of launch, or logged a main-process crash"
	fi
	echo "[prod-app] launch check OK: $MAIN_EXE pid $first_pid alive after ~18s"
fi
rm -rf "$PREV_APP"

echo "[prod-app] installed and launched $INSTALLED_APP"
