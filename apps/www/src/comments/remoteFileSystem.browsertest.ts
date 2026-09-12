import { describe, expect, it } from "vitest";
import { toSidecarMap } from "../store/sidecars";
import { createRemoteFileSystem } from "./remoteFileSystem";

type Row = {
	path: string;
	content: string;
	contentHash: string;
	updatedAt: number;
	deleted: boolean;
};

const row = (
	path: string,
	content = `content of ${path}`,
	hash = `hash-of-${path}`,
	deleted = false,
): Row => ({ path, content, contentHash: hash, updatedAt: 1, deleted });

function fsFromRows(rows: Row[]) {
	return createRemoteFileSystem(toSidecarMap(rows));
}

describe("remoteFileSystem.listDir (the slot-listing trap)", () => {
	it("returns ALL slots including ones this device does not own", async () => {
		const fs = fsFromRows([
			row(".mdly/comments/doc-1.jsonl"),
			row(".mdly/comments/doc-1 2.jsonl"),
			row(".mdly/comments/doc-1 3.jsonl"),
		]);
		expect((await fs.listDir(".mdly/comments")).sort()).toEqual([
			"doc-1 2.jsonl",
			"doc-1 3.jsonl",
			"doc-1.jsonl",
		]);
	});

	it("returns [] for a missing directory instead of throwing", async () => {
		const fs = fsFromRows([row(".mdly/comments/doc-1.jsonl")]);
		await expect(fs.listDir(".mdly/history")).resolves.toEqual([]);
		await expect(fs.listDir(".mdly/nope")).resolves.toEqual([]);
	});

	it("excludes tombstoned rows from the map", async () => {
		const fs = fsFromRows([
			row(".mdly/comments/gone.jsonl", "old", "h-old", true),
			row(".mdly/comments/live.jsonl"),
		]);
		expect(await fs.listDir(".mdly/comments")).toEqual(["live.jsonl"]);
		await expect(fs.readFile(".mdly/comments/gone.jsonl")).resolves.toBeNull();
	});

	it("does not flatten nested paths into the parent", async () => {
		const fs = fsFromRows([
			row(".mdly/comments/doc-1.jsonl"),
			row(".mdly/comments/sub/nested.jsonl"),
		]);
		expect(await fs.listDir(".mdly/comments")).toEqual(["doc-1.jsonl"]);
		expect(await fs.listDir(".mdly/comments/sub")).toEqual(["nested.jsonl"]);
	});

	it("reads back encoded content, null when absent; exists is a key check", async () => {
		const fs = fsFromRows([row(".mdly/history/index.jsonl", '{"a":1}')]);
		const bytes = await fs.readFile(".mdly/history/index.jsonl");
		expect(bytes ? new TextDecoder().decode(bytes) : null).toBe('{"a":1}');
		await expect(fs.readFile(".mdly/history/missing.jsonl")).resolves.toBeNull();
		await expect(fs.exists(".mdly/history/index.jsonl")).resolves.toBe(true);
		await expect(fs.exists(".mdly/history/missing.jsonl")).resolves.toBe(false);
	});

	it("writeFile throws and mkdirRecursive is a no-op (reads only)", async () => {
		const fs = fsFromRows([]);
		await expect(fs.writeFile(".mdly/comments/x.jsonl", new Uint8Array())).rejects.toThrow();
		await expect(fs.mkdirRecursive(".mdly/comments")).resolves.toBeUndefined();
	});
});
