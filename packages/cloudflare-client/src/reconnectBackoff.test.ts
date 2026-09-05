import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "./subscriber.js";

/**
 * A fixed 1s retry turned a persistently failing server into an amplifier:
 * every client retried once a second forever, and each attempt cost the
 * Durable Object more row reads. These tests pin the properties that stop
 * that: the first retry stays fast, repeated failure backs off to a cap, and
 * jitter never pushes a delay outside the allowed band.
 */
describe("reconnect backoff", () => {
	const noJitter = () => 0.5; // random()*2-1 === 0 → exact exponential

	it("first retry is EXACTLY the base delay, at any jitter — an ordinary blip recovers predictably", () => {
		for (const random of [() => 0, () => 0.5, () => 1]) {
			expect(reconnectDelayMs(0, random)).toBe(1000);
		}
	});

	it("doubles per consecutive failure once past the first retry", () => {
		expect(reconnectDelayMs(1, noJitter)).toBe(2000);
		expect(reconnectDelayMs(2, noJitter)).toBe(4000);
		expect(reconnectDelayMs(3, noJitter)).toBe(8000);
	});

	it("caps at one attempt per minute — a 60x cut in retry cost during an outage", () => {
		expect(reconnectDelayMs(6, noJitter)).toBe(60000);
		expect(reconnectDelayMs(50, noJitter)).toBe(60000);
		expect(reconnectDelayMs(1000, noJitter)).toBe(60000);
	});

	it("never returns below the base delay or above the cap, at any jitter", () => {
		for (const random of [() => 0, () => 1, () => 0.5, () => 0.999]) {
			for (let attempt = 0; attempt < 40; attempt++) {
				const delay = reconnectDelayMs(attempt, random);
				expect(delay).toBeGreaterThanOrEqual(1000);
				expect(delay).toBeLessThanOrEqual(60000);
			}
		}
	});

	it("jitters around the exponential so many clients do not retry in lockstep", () => {
		const low = reconnectDelayMs(3, () => 0); // -20%
		const high = reconnectDelayMs(3, () => 1); // +20%
		expect(low).toBe(6400);
		expect(high).toBe(9600);
		expect(low).toBeLessThan(high);
	});

	it("treats a negative attempt count as the first attempt rather than shrinking below base", () => {
		expect(reconnectDelayMs(-5, noJitter)).toBe(1000);
	});

	it("jitter applies from the second retry onward, not the first", () => {
		expect(reconnectDelayMs(0, () => 1)).toBe(reconnectDelayMs(0, () => 0));
		expect(reconnectDelayMs(1, () => 1)).not.toBe(reconnectDelayMs(1, () => 0));
	});
});
