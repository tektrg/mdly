import { describe, expect, it } from "vitest";
import { createIdGenerator } from "./ids.js";

describe("createIdGenerator", () => {
	it("produces unique ids across many calls from one instance", () => {
		const generator = createIdGenerator();
		const ids = new Set<string>();
		for (let i = 0; i < 2000; i++) {
			ids.add(generator.next());
		}
		expect(ids.size).toBe(2000);
	});

	it("never collides across two independent writer instances under the same clock tick (R36, QA6b)", () => {
		// Simulates two independent devices/processes generating ids at
		// effectively the same instant: two separate generator instances (no
		// shared counter state) under an identical mocked `now`.
		const deviceA = createIdGenerator();
		const deviceB = createIdGenerator();
		const sameInstant = 1_755_000_000_000;

		const idsFromA = new Set<string>();
		const idsFromB = new Set<string>();
		for (let i = 0; i < 500; i++) {
			idsFromA.add(deviceA.next(sameInstant));
			idsFromB.add(deviceB.next(sameInstant));
		}

		const collisions = [...idsFromA].filter((id) => idsFromB.has(id));
		expect(collisions).toEqual([]);
	});

	it("is roughly time-sortable: a later timestamp yields a lexicographically later id", () => {
		const generator = createIdGenerator();
		const earlier = generator.next(1_700_000_000_000);
		const later = generator.next(1_800_000_000_000);
		expect(later > earlier).toBe(true);
	});
});
