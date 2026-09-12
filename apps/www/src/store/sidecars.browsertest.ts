import { describe, expect, it } from "vitest";
import {
	isSidecarRow,
	sidecarsChanged,
	toSidecarMap,
} from "./sidecars";

const row = (
	path: string,
	contentHash = `hash-of-${path}`,
	deleted = false,
) => ({
	path,
	content: `content of ${path}`,
	contentHash,
	updatedAt: 1,
	deleted,
});

describe("sidecar partition (shared by snapshot, refresh, broadcast)", () => {
	it("keeps sidecar rows with content, drops notes and tombstones", () => {
		const map = toSidecarMap([
			row("note.md"),
			row(".mdly/comments/doc-1.jsonl"),
			row(".mdly/history/index.jsonl"),
			row(".mdly/comments/gone.jsonl", "h-old", true),
		]);
		expect(Object.keys(map).sort()).toEqual([
			".mdly/comments/doc-1.jsonl",
			".mdly/history/index.jsonl",
		]);
		expect(map[".mdly/comments/doc-1.jsonl"]?.content).toBe(
			"content of .mdly/comments/doc-1.jsonl",
		);
	});

	it("isSidecarRow fences every .mdly row, nothing else", () => {
		expect(isSidecarRow(".mdly/comments/x.jsonl")).toBe(true);
		expect(isSidecarRow(".mdly/history/index.jsonl")).toBe(true);
		expect(isSidecarRow("note.md")).toBe(false);
		expect(isSidecarRow("mdly-note.md")).toBe(false);
	});

	it("sidecarsChanged bumps only on real content movement", () => {
		const base = toSidecarMap([row(".mdly/comments/a.jsonl")]);
		// Same hashes, new updatedAt only → quiet.
		const sameHash = {
			".mdly/comments/a.jsonl": {
				path: ".mdly/comments/a.jsonl",
				content: "rewritten bytes, same event",
				contentHash: "hash-of-.mdly/comments/a.jsonl",
				updatedAt: 999,
			},
		};
		expect(sidecarsChanged(base, sameHash)).toBe(false);
		expect(sidecarsChanged(base, base)).toBe(false);
		// Added, removed, or re-hashed → bump.
		expect(
			sidecarsChanged(
				base,
				toSidecarMap([
					row(".mdly/comments/a.jsonl"),
					row(".mdly/comments/b.jsonl"),
				]),
			),
		).toBe(true);
		expect(sidecarsChanged(base, {})).toBe(true);
		expect(
			sidecarsChanged(
				base,
				toSidecarMap([row(".mdly/comments/a.jsonl", "hash-new")]),
			),
		).toBe(true);
	});
});
