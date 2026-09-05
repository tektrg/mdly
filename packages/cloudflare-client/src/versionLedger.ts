/**
 * Self-echo suppression ledger (DO row-read frequency fix, 2b).
 *
 * Every mutation response already carries the new workspace version number,
 * but the broadcast payload is `{type, version}` with no origin — so the
 * device that just wrote re-reads everything in response to its own write.
 * The backend records each version it produced here; the subscriber skips
 * `notifyAll()` when an incoming version is a member of this ledger.
 *
 * Exact membership, NEVER "version <= my latest": a `<=` rule would silently
 * swallow another device's change that landed with a lower number, which is
 * a data-loss-shaped bug. Exact membership cannot do that.
 *
 * Bounded: a `Set` for O(1) lookup plus a FIFO queue that evicts the oldest
 * entry past the cap, so a long-lived client cannot grow it forever.
 */
export type VersionLedger = {
	/** Record a version this client produced. */
	record(version: number): void;
	/** True only when this exact version was recorded (and not yet evicted). */
	has(version: number): boolean;
	/** Current entry count — for tests and diagnostics. */
	size(): number;
};

export const DEFAULT_LEDGER_CAP = 200;

export function createVersionLedger(cap = DEFAULT_LEDGER_CAP): VersionLedger {
	const seen = new Set<number>();
	const fifo: number[] = [];
	return {
		record(version: number): void {
			if (seen.has(version)) return;
			seen.add(version);
			fifo.push(version);
			while (fifo.length > cap) {
				const oldest = fifo.shift() as number;
				seen.delete(oldest);
			}
		},
		has(version: number): boolean {
			return seen.has(version);
		},
		size(): number {
			return seen.size;
		},
	};
}
