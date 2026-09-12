import { describe, expect, it } from "vitest";
import {
	commentLogSlotOf,
	isPushableSidecarPath,
	isSidecarPath,
	isSyncedSidecarPath,
	SIDECAR_PREFIX,
} from "./sidecarScope.js";

// tombstone-then-403-fence (Step 1): unit coverage for the four predicates.
// The slot regex must mirror COMMENT_LOG_PATTERN in
// apps/www/worker/durableObject/files.ts — the multi-digit, canonical, and
// case-insensitive cases below are the drift detectors for that mirror.
describe("sidecarScope fence", () => {
	it("exposes the .mdly/ prefix", () => {
		expect(SIDECAR_PREFIX).toBe(".mdly/");
	});

	it("isSidecarPath fences every .mdly row, nothing else", () => {
		expect(isSidecarPath(".mdly/comments/note.jsonl")).toBe(true);
		expect(isSidecarPath(".mdly/comments/note 2.jsonl")).toBe(true);
		expect(isSidecarPath(".mdly/history/index.jsonl")).toBe(true);
		expect(isSidecarPath(".mdly/history/objects/ab/abcd1234")).toBe(true);
		expect(isSidecarPath(".mdly/config.json")).toBe(true);
		expect(isSidecarPath(".mdly")).toBe(true);
		expect(isSidecarPath("note.md")).toBe(false);
		expect(isSidecarPath("folder/note.md")).toBe(false);
		expect(isSidecarPath(".hubble/config.json")).toBe(false);
		expect(isSidecarPath("mdly-note.md")).toBe(false);
	});

	it("isSyncedSidecarPath allowlists comment logs + history index only", () => {
		expect(isSyncedSidecarPath(".mdly/comments/note.jsonl")).toBe(true);
		expect(isSyncedSidecarPath(".mdly/comments/note 2.jsonl")).toBe(true);
		expect(isSyncedSidecarPath(".mdly/comments/nested/note.jsonl")).toBe(true);
		expect(isSyncedSidecarPath(".mdly/history/index.jsonl")).toBe(true);
		// Revision blobs never leave the Mac.
		expect(isSyncedSidecarPath(".mdly/history/objects/ab/abcd1234")).toBe(
			false,
		);
		expect(isSyncedSidecarPath(".mdly/history/log/doc-1.jsonl")).toBe(false);
		expect(isSyncedSidecarPath(".mdly/config.json")).toBe(false);
		expect(isSyncedSidecarPath(".mdly/comments/note.md")).toBe(false);
		expect(isSyncedSidecarPath(".mdly/comments/note.jsonl.bak")).toBe(false);
		expect(isSyncedSidecarPath("note.md")).toBe(false);
	});

	it("commentLogSlotOf mirrors the server slot invariant", () => {
		// Canonical (desktop-owned): null.
		expect(commentLogSlotOf(".mdly/comments/note.jsonl")).toBeNull();
		// Slotted siblings: the owning slot number, including multi-digit.
		expect(commentLogSlotOf(".mdly/comments/note 2.jsonl")).toBe(2);
		expect(commentLogSlotOf(".mdly/comments/note 10.jsonl")).toBe(10);
		// Extension matches case-insensitively, exactly like the server.
		expect(commentLogSlotOf(".mdly/comments/note 2.JSONL")).toBe(2);
		// Not a comment log: undefined (history index, notes, blobs).
		expect(commentLogSlotOf(".mdly/history/index.jsonl")).toBeUndefined();
		expect(commentLogSlotOf("note.md")).toBeUndefined();
		expect(
			commentLogSlotOf(".mdly/history/objects/ab/abcd1234"),
		).toBeUndefined();
	});

	it("isPushableSidecarPath lets the slotless desktop push canonical + index only", () => {
		expect(isPushableSidecarPath(".mdly/comments/note.jsonl")).toBe(true);
		expect(isPushableSidecarPath(".mdly/history/index.jsonl")).toBe(true);
		// Browser slots: the server would 403 these for a slotless caller.
		expect(isPushableSidecarPath(".mdly/comments/note 2.jsonl")).toBe(false);
		expect(isPushableSidecarPath(".mdly/comments/note 10.jsonl")).toBe(false);
		// Unsynced sidecars are pushable nowhere.
		expect(isPushableSidecarPath(".mdly/history/objects/ab/abcd1234")).toBe(
			false,
		);
		expect(isPushableSidecarPath(".mdly/config.json")).toBe(false);
		expect(isPushableSidecarPath("note.md")).toBe(false);
	});
});
