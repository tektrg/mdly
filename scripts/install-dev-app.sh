#!/bin/bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Hubble Dev"
BUILT_APP="$REPO_DIR/$APP_NAME.app"
INSTALLED_APP="/Applications/$APP_NAME.app"
PNPM="${PNPM:-/Users/trungluong/.nvm/versions/node/v22.22.2/bin/pnpm}"

if [[ ! -x "$PNPM" ]]; then
	PNPM="$(command -v pnpm || true)"
fi

if [[ -z "$PNPM" ]]; then
	echo "[dev-app] pnpm not found. Set PNPM=/path/to/pnpm and try again." >&2
	exit 1
fi

cd "$REPO_DIR"
"$PNPM" build:dev-app

rm -rf "$INSTALLED_APP"
/usr/bin/ditto "$BUILT_APP" "$INSTALLED_APP"

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
	-f "$INSTALLED_APP"

open "$INSTALLED_APP"

echo "[dev-app] installed and launched $INSTALLED_APP"
