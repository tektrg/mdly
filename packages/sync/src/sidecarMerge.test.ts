import { describe, expect, it } from "vitest";
import { mergeJsonlUnion } from "./sidecarMerge.js";

const ev = (id: string, body = "") =>
	JSON.stringify({ id, body: body || id });

describe("mergeJsonlUnion (sidecar-union-plan)", () => {
	it("is commutative: both directions converge to byte-identical output", () => {
		const a = `${ev("a", "from-a")}\n${ev("b")}\n`;
		const b = `${ev("b")}\n${ev("c", "from-b")}\n`;
		const fromA = mergeJsonlUnion(a, b);
		const fromB = mergeJsonlUnion(b, a);
		expect(fromB).toBe(fromA);
		expect(fromA).toBe(
			`${ev("a", "from-a")}\n${ev("b")}\n${ev("c", "from-b")}\n`,
		);
	});

	it("is idempotent: re-merging the union changes nothing", async () => {
		const a = `${ev("a")}\n${ev("b")}\n`;
		const b = `${ev("b")}\n${ev("c")}\n`;
		const once = mergeJsonlUnion(a, b);
		expect(mergeJsonlUnion(once, a)).toBe(once);
		expect(mergeJsonlUnion(once, once)).toBe(once);
	});

	it("sorts id lines ascending by plain string comparison, id-less last", () => {
		// Plain string order, NOT numeric: "10" < "9" < "a".
		const local = `${ev("a")}\n${ev("9")}\n`;
		const remote = `${ev("10")}\nleftover\n`;
		expect(mergeJsonlUnion(local, remote)).toBe(
			`${ev("10")}\n${ev("9")}\n${ev("a")}\nleftover\n`,
		);
	});

	it("keeps a truncated final line with no trailing newline", () => {
		const local = `${ev("a")}\n`;
		const remote = `${ev("b")}\n{"id":"c","body":"tru`;
		const merged = mergeJsonlUnion(local, remote);
		expect(merged).toBe(`${ev("a")}\n${ev("b")}\n{"id":"c","body":"tru\n`);
		// And it round-trips: merging again is a fixed point.
		expect(mergeJsonlUnion(merged, local)).toBe(merged);
	});

	it("preserves id-less lines deduped by exact text", () => {
		const local = `\nnot-json\n${ev("a")}\n{"noid":true}\n[1,2]\n`;
		const remote = `not-json\n{"noid":true}\n"just-a-string"\n`;
		expect(mergeJsonlUnion(local, remote)).toBe(
			`${ev("a")}\n\n"just-a-string"\n[1,2]\nnot-json\n{"noid":true}\n`,
		);
	});

	it("resolves same-id different payloads to the lexicographically greater line", () => {
		const a = JSON.stringify({ id: "x", body: "aaa" });
		const b = JSON.stringify({ id: "x", body: "zzz" });
		const expected = `${b}\n`;
		expect(mergeJsonlUnion(`${a}\n`, `${b}\n`)).toBe(expected);
		expect(mergeJsonlUnion(`${b}\n`, `${a}\n`)).toBe(expected);
	});

	it("returns empty string for empty inputs and a single trailing newline otherwise", () => {
		expect(mergeJsonlUnion("", "")).toBe("");
		expect(mergeJsonlUnion(`${ev("a")}`, "")).toBe(`${ev("a")}\n`);
		const merged = mergeJsonlUnion(`${ev("a")}\n`, `${ev("b")}\n`);
		expect(merged.endsWith("\n")).toBe(true);
		expect(merged.endsWith("\n\n")).toBe(false);
	});
});
