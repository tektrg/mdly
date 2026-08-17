/**
 * Sortable, collision-resistant id generation (R36 — two independent
 * writers/devices generating an id at the same instant must never collide).
 *
 * Shape: `<9-char base36 ms timestamp><2-char base36 counter><4-char base36
 * random>`. The timestamp makes ids roughly time-sortable; the per-instance
 * counter disambiguates same-millisecond calls from one writer; the random
 * suffix (from Web Crypto, portable across Node and browsers) disambiguates
 * independent writers/devices from each other.
 */

const TIMESTAMP_RADIX_WIDTH = 9;
const COUNTER_RADIX_WIDTH = 2;
// 6 base36 chars (~31 bits) keeps same-millisecond, same-counter collisions
// across independent writers vanishingly unlikely (R36).
const RANDOM_RADIX_WIDTH = 6;
const COUNTER_MODULUS = 36 ** COUNTER_RADIX_WIDTH;

export interface IdGenerator {
	next(now?: number): string;
}

function randomBase36(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	return Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
}

/**
 * Creates an independent id generator with its own counter state. Tests use
 * two separate instances to simulate two independent devices/processes.
 */
export function createIdGenerator(): IdGenerator {
	let counter = 0;
	return {
		next(now = Date.now()) {
			counter = (counter + 1) % COUNTER_MODULUS;
			const timestamp = now.toString(36).padStart(TIMESTAMP_RADIX_WIDTH, "0");
			const counterPart = counter
				.toString(36)
				.padStart(COUNTER_RADIX_WIDTH, "0");
			return `${timestamp}${counterPart}${randomBase36(RANDOM_RADIX_WIDTH)}`;
		},
	};
}

const defaultGenerator = createIdGenerator();

/** Convenience wrapper around a lazily-shared default generator instance. */
export function generateId(now?: number): string {
	return defaultGenerator.next(now);
}
