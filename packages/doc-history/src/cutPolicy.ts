/**
 * Framework-agnostic idle/forced history-cut timer policy (R15, R16). This is
 * the shared, testable "when should we cut a revision while the user keeps
 * typing" state machine; `packages/workspace-kit/src/ui/EditorView.tsx` is
 * thin React glue around an instance of this, wiring `onEdit()` to
 * keystrokes and the `onCut` callback to a history-recording save. Kept
 * dependency-injected on the clock so tests run entirely on fake timers,
 * never real wall-clock waits.
 */
export type CutCause = "idle-session" | "forced";

export interface CutPolicyClock {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface CutPolicyOptions {
	/** Resettable idle window; default 3 minutes (R15). */
	idleMs?: number;
	/** Non-resettable ceiling during continuous typing; default 30 minutes (R16). */
	forcedMs?: number;
	clock?: CutPolicyClock;
}

export interface CutPolicy {
	/** Call on every keystroke/edit. */
	onEdit(): void;
	/** Clears both timers; call on unmount/file-close. */
	dispose(): void;
}

export const DEFAULT_IDLE_CUT_MS = 3 * 60 * 1000;
export const DEFAULT_FORCED_CUT_MS = 30 * 60 * 1000;

const realClock: CutPolicyClock = {
	setTimeout: (handler, ms) => setTimeout(handler, ms),
	clearTimeout: (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createCutPolicy(
	onCut: (cause: CutCause) => void,
	options: CutPolicyOptions = {},
): CutPolicy {
	const idleMs = options.idleMs ?? DEFAULT_IDLE_CUT_MS;
	const forcedMs = options.forcedMs ?? DEFAULT_FORCED_CUT_MS;
	const clock = options.clock ?? realClock;

	let idleTimer: unknown = null;
	let forcedTimer: unknown = null;
	let hasPendingEdit = false;

	function clearIdleTimer() {
		if (idleTimer !== null) {
			clock.clearTimeout(idleTimer);
			idleTimer = null;
		}
	}

	function clearForcedTimer() {
		if (forcedTimer !== null) {
			clock.clearTimeout(forcedTimer);
			forcedTimer = null;
		}
	}

	function fireIdle() {
		idleTimer = null;
		if (!hasPendingEdit) return;
		hasPendingEdit = false;
		// A cut just captured everything pending; the forced ceiling's window
		// starts fresh on the next edit rather than firing again immediately.
		clearForcedTimer();
		onCut("idle-session");
	}

	function fireForced() {
		forcedTimer = null;
		if (hasPendingEdit) {
			hasPendingEdit = false;
			onCut("forced");
		}
		// Recurring: a long uninterrupted typing session keeps accumulating
		// history every `forcedMs`, not just once (R16).
		forcedTimer = clock.setTimeout(fireForced, forcedMs);
	}

	return {
		onEdit() {
			hasPendingEdit = true;
			clearIdleTimer();
			idleTimer = clock.setTimeout(fireIdle, idleMs);
			if (forcedTimer === null) {
				forcedTimer = clock.setTimeout(fireForced, forcedMs);
			}
		},
		dispose() {
			clearIdleTimer();
			clearForcedTimer();
			hasPendingEdit = false;
		},
	};
}
