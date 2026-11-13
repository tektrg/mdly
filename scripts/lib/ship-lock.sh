# shellcheck shell=bash
# Per-machine mutual exclusion for prod ships (sourced by install-prod-app.sh and
# the parent repo's prod-push.sh). macOS has no flock(1); mkdir is atomic.
#
#   ship_lock_acquire <label>   wait (<= SHIP_LOCK_TIMEOUT s, default 1200) for
#                               the lock; take over a lock whose owner PID is dead.
#   ship_lock_release           release it if this process owns it.
#
# Re-entrant across a parent/child pair on ONE machine: the holder exports
# MDLY_SHIP_LOCK_HELD=<host>:<pid>, and a child on the same host skips acquiring.
# ssh does not forward it, so the other Mac always takes its own lock.
# Lock order is always Air -> Pro (push holds the Air lock while installing on
# the Pro; pull never holds the Pro lock while waiting on the Air) -> no deadlock.

SHIP_LOCK_DIR="${SHIP_LOCK_DIR:-/tmp/mdly-prod-ship.lock}"
SHIP_LOCK_OWNED=0

ship_lock_acquire() {
	local label="${1:-prod ship}" host waited=0 timeout="${SHIP_LOCK_TIMEOUT:-1200}" owner pid
	host="$(hostname -s)"
	if [[ "${MDLY_SHIP_LOCK_HELD:-}" == "$host:"* ]]; then
		echo "[ship-lock] reusing lock held by parent ${MDLY_SHIP_LOCK_HELD}"
		return 0
	fi
	while ! mkdir "$SHIP_LOCK_DIR" 2>/dev/null; do
		owner="$(cat "$SHIP_LOCK_DIR/owner" 2>/dev/null || true)"
		pid="$(sed -n 's/^pid=//p' <<<"$owner")"
		if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
			echo "[ship-lock] taking over stale lock (owner pid $pid is dead): $(tr '\n' ' ' <<<"$owner")" >&2
			rm -rf "$SHIP_LOCK_DIR"
			continue
		fi
		if [[ -z "$pid" && -d "$SHIP_LOCK_DIR" ]]; then
			# Owner file not written yet (holder is between mkdir and write) or
			# lost; treat as stale only after it has stayed empty for 30s.
			if (( waited >= 30 )) && [[ -z "$(cat "$SHIP_LOCK_DIR/owner" 2>/dev/null)" ]]; then
				echo "[ship-lock] taking over ownerless lock $SHIP_LOCK_DIR" >&2
				rm -rf "$SHIP_LOCK_DIR"
				continue
			fi
		fi
		if (( waited >= timeout )); then
			echo "[ship-lock] FAILED: prod ship lock still held after ${timeout}s: $(tr '\n' ' ' <<<"$owner")" >&2
			return 1
		fi
		(( waited % 30 == 0 )) && echo "[ship-lock] waiting for prod ship by PID ${pid:-?} ($(sed -n 's/^label=//p' <<<"$owner"), since $(sed -n 's/^since=//p' <<<"$owner"))..." >&2
		sleep 5
		waited=$((waited + 5))
	done
	printf 'pid=%s\nhost=%s\nsince=%s\nlabel=%s\n' "$$" "$host" "$(date '+%Y-%m-%dT%H:%M:%S')" "$label" >"$SHIP_LOCK_DIR/owner"
	SHIP_LOCK_OWNED=1
	export MDLY_SHIP_LOCK_HELD="$host:$$"
	echo "[ship-lock] acquired $SHIP_LOCK_DIR ($label)"
}

ship_lock_release() {
	if [[ "$SHIP_LOCK_OWNED" == "1" ]] && [[ "$(sed -n 's/^pid=//p' "$SHIP_LOCK_DIR/owner" 2>/dev/null)" == "$$" ]]; then
		rm -rf "$SHIP_LOCK_DIR"
		SHIP_LOCK_OWNED=0
		echo "[ship-lock] released $SHIP_LOCK_DIR"
	fi
}
