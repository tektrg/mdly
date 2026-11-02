/**
 * Saved views R20: a window must not close (or the app quit) while the
 * renderer still holds an unsaved saved-views edit. `beforeunload` alone
 * can't await the IPC write, so the main process holds the close, asks the
 * renderer to flush, and closes once it answers — or after a timeout, so a
 * hung renderer can never block quit.
 */
export type CloseEventLike = { preventDefault(): void };

export function createFlushBeforeClose(options: {
	/** Asks the renderer to save pending edits; resolves when it has. */
	requestFlush: () => Promise<void>;
	/** Closes for real (the guard lets this second close through). */
	close: () => void;
	timeoutMs: number;
}) {
	let state: "open" | "flushing" | "done" = "open";
	return function onClose(event: CloseEventLike) {
		if (state === "done") return;
		event.preventDefault();
		if (state === "flushing") return;
		state = "flushing";
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, options.timeoutMs);
		});
		void Promise.race([
			options.requestFlush().catch(() => undefined),
			timeout,
		]).then(() => {
			if (timer) clearTimeout(timer);
			state = "done";
			options.close();
		});
	};
}

export const FLUSH_REQUEST_CHANNEL = "desktop:flush-pending-saves";
export const FLUSH_DONE_CHANNEL = "desktop:flush-pending-saves-done";
