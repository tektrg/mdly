/**
 * Safety net for unexpected main-process failures (F3): log them, keep the
 * app running, and surface a dismissible in-app notice — instead of
 * Electron's default modal dialog, which freezes the whole app on the main
 * thread until it is force-quit.
 *
 * Kept in its own module (rather than inline in `main.ts`) because `main.ts`
 * imports Electron and cannot run under vitest; everything here is pure and
 * unit-tested via injected `recordEvent`/`notifyRenderer` deps. `main.ts`
 * only calls `installMainProcessErrorHandlers()`.
 */

/** Compact payload forwarded to the renderer for the in-app notice. The full stack stays in the crash-trace log — never in the UI. */
export interface MainProcessErrorNoticePayload {
	/** Stable per-error key (`Name: first message line`), also the toast id so repeats update instead of stacking. */
	key: string;
	/** Short human line, e.g. `Error: WebSocket was closed…`. */
	message: string;
}

export interface MainProcessErrorReporterDeps {
	recordEvent: (event: string, data?: Record<string, unknown>) => void;
	notifyRenderer: (payload: MainProcessErrorNoticePayload) => void;
	now?: () => number;
}

/** One notice per error key per window; repeats inside the window are counted, not re-emitted (a fault inside a timer would otherwise spam). */
export const MAIN_PROCESS_ERROR_NOTICE_COOLDOWN_MS = 60_000;

/** Bounds the tracker itself — a storm of distinct messages must not grow memory unboundedly. */
const MAX_TRACKED_ERROR_KEYS = 50;

export function mainProcessErrorKey(error: unknown): string {
	const firstLine =
		error instanceof Error
			? `${error.name}: ${error.message}`
			: `Unknown: ${String(error)}`;
	// Compact by contract: a multi-KB single-line message must not ride
	// along verbatim over IPC and into the toast description.
	return firstLine.split("\n")[0]?.slice(0, 200) ?? "Unknown";
}

export function createMainProcessErrorReporter(
	deps: MainProcessErrorReporterDeps,
) {
	const now = deps.now ?? Date.now;
	const seen = new Map<
		string,
		{ lastNotifiedAt: number; suppressed: number }
	>();

	function report(error: unknown): void {
		// This runs *because* something already broke: it must never throw
		// itself, so the whole body is guarded, not just the risky calls.
		try {
			const key = mainProcessErrorKey(error);
			const at = now();
			const tracked = seen.get(key);
			if (
				tracked &&
				at - tracked.lastNotifiedAt < MAIN_PROCESS_ERROR_NOTICE_COOLDOWN_MS
			) {
				tracked.suppressed += 1;
				return;
			}
			const repeated = tracked?.suppressed ?? 0;
			seen.delete(key);
			if (seen.size >= MAX_TRACKED_ERROR_KEYS) {
				const oldest = seen.keys().next();
				if (!oldest.done) seen.delete(oldest.value);
			}
			seen.set(key, { lastNotifiedAt: at, suppressed: 0 });
			const stack = error instanceof Error ? error.stack : undefined;
			deps.recordEvent("main-process-error", {
				key,
				message: key,
				...(stack ? { stack } : {}),
				...(repeated > 0 ? { suppressedRepeats: repeated } : {}),
			});
			deps.notifyRenderer({ key, message: key });
		} catch {
			// Never throw out of the crash handler.
		}
	}

	return { report };
}

/**
 * Install once, primary instance only. Adding ANY `uncaughtException`
 * listener replaces Electron's default modal dialog — that is the point:
 * the app logs the fault, stays running, and notifies the renderer instead
 * of freezing. `unhandledRejection` is routed through the same path: an
 * unhandled rejection in main is the same user-visible freeze risk, and
 * handling it here costs nothing extra. Never exits: exiting would turn
 * every background fault into lost work.
 */
export function installMainProcessErrorHandlers(
	deps: MainProcessErrorReporterDeps,
): () => void {
	const { report } = createMainProcessErrorReporter(deps);
	const onUncaughtException = (error: Error): void => {
		report(error);
	};
	const onUnhandledRejection = (reason: unknown): void => {
		report(reason);
	};
	process.on("uncaughtException", onUncaughtException);
	process.on("unhandledRejection", onUnhandledRejection);
	return () => {
		process.removeListener("uncaughtException", onUncaughtException);
		process.removeListener("unhandledRejection", onUnhandledRejection);
	};
}
