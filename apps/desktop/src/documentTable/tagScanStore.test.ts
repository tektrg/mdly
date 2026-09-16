import { beforeEach, describe, expect, it } from "vitest";
import {
	beginTagScan,
	completeTagScan,
	failTagScan,
	isTagScanReadyFor,
	resetTagScan,
	tagScanPathsToScan,
	tagScanStore,
	tagsForScope,
	upsertTagsForPath,
} from "./tagScanStore";

const WORKSPACE = "/w/one";
const OTHER_WORKSPACE = "/w/two";

const fileA = { path: "/w/one/a.md", modifiedAt: 100 };
const fileB = { path: "/w/one/b.md", modifiedAt: 200 };
const files = [fileA, fileB];

function scanComplete(tags: Record<string, string[]>) {
	completeTagScan({
		scope: WORKSPACE,
		files,
		scannedPaths: files.map((file) => file.path),
		tags,
	});
}

describe("tagScanStore (A9)", () => {
	beforeEach(() => {
		resetTagScan();
	});

	it("starts idle and reports a pending scan for a workspace with no map", () => {
		expect(tagScanStore.get()).toEqual({ kind: "idle" });

		beginTagScan(WORKSPACE);

		expect(tagScanStore.get()).toEqual({ kind: "scanning", scope: WORKSPACE });
		expect(isTagScanReadyFor(tagScanStore.get(), WORKSPACE)).toBe(false);
	});

	it("makes a failed scan representable and readable -- never a silent empty map", () => {
		beginTagScan(WORKSPACE);
		failTagScan(WORKSPACE, "Permission denied");

		expect(tagScanStore.get()).toEqual({
			kind: "failed",
			scope: WORKSPACE,
			message: "Permission denied",
		});
		// Crucially NOT "scanned with no tags", which would render as Untagged.
		expect(tagsForScope(tagScanStore.get(), WORKSPACE)).toBeNull();
	});

	it("carries the scope inside the value, so another workspace's map is never current", () => {
		beginTagScan(WORKSPACE);
		scanComplete({ "/w/one/a.md": ["x"] });

		expect(isTagScanReadyFor(tagScanStore.get(), WORKSPACE)).toBe(true);
		expect(isTagScanReadyFor(tagScanStore.get(), OTHER_WORKSPACE)).toBe(false);
		expect(tagsForScope(tagScanStore.get(), OTHER_WORKSPACE)).toBeNull();
	});

	it("drops a result that arrives after the workspace moved on", () => {
		beginTagScan(WORKSPACE);
		beginTagScan(OTHER_WORKSPACE);

		// The first workspace's scan finally resolves.
		scanComplete({ "/w/one/a.md": ["x"] });

		expect(tagScanStore.get()).toEqual({
			kind: "scanning",
			scope: OTHER_WORKSPACE,
		});
	});

	it("ignores a failure reported for a workspace that is no longer current", () => {
		beginTagScan(WORKSPACE);
		beginTagScan(OTHER_WORKSPACE);
		failTagScan(WORKSPACE, "too late");

		expect(tagScanStore.get()).toMatchObject({ kind: "scanning" });
	});

	it("does not blank an existing map when an incremental rescan starts", () => {
		beginTagScan(WORKSPACE);
		scanComplete({ "/w/one/a.md": ["x"] });

		beginTagScan(WORKSPACE);

		expect(tagScanStore.get()).toMatchObject({ kind: "scanned" });
	});
});

describe("tagScanPathsToScan (EC-61, EC-67)", () => {
	beforeEach(() => {
		resetTagScan();
	});

	it("asks for every path when there is no map for this workspace", () => {
		expect(tagScanPathsToScan(tagScanStore.get(), WORKSPACE, files)).toEqual([
			"/w/one/a.md",
			"/w/one/b.md",
		]);
	});

	it("asks for nothing at all when an unchanged listing comes back", () => {
		beginTagScan(WORKSPACE);
		scanComplete({ "/w/one/a.md": ["x"] });

		expect(tagScanPathsToScan(tagScanStore.get(), WORKSPACE, files)).toEqual(
			[],
		);
	});

	it("asks only for new and modified paths", () => {
		beginTagScan(WORKSPACE);
		scanComplete({ "/w/one/a.md": ["x"] });

		const next = [
			fileA,
			{ path: "/w/one/b.md", modifiedAt: 999 },
			{ path: "/w/one/c.md", modifiedAt: 300 },
		];

		expect(tagScanPathsToScan(tagScanStore.get(), WORKSPACE, next)).toEqual([
			"/w/one/b.md",
			"/w/one/c.md",
		]);
	});

	it("asks for everything again after a workspace switch", () => {
		beginTagScan(WORKSPACE);
		scanComplete({ "/w/one/a.md": ["x"] });

		expect(
			tagScanPathsToScan(tagScanStore.get(), OTHER_WORKSPACE, files),
		).toHaveLength(2);
	});
});

describe("completeTagScan merging (defect 16/21)", () => {
	beforeEach(() => {
		resetTagScan();
		beginTagScan(WORKSPACE);
		scanComplete({ "/w/one/a.md": ["x"], "/w/one/b.md": ["y"] });
	});

	it("keeps tags for paths the incremental scan did not request", () => {
		completeTagScan({
			scope: WORKSPACE,
			files,
			scannedPaths: ["/w/one/b.md"],
			tags: { "/w/one/b.md": ["y2"] },
		});

		expect(tagsForScope(tagScanStore.get(), WORKSPACE)).toEqual({
			"/w/one/a.md": ["x"],
			"/w/one/b.md": ["y2"],
		});
	});

	it("reads an OMITTED requested path as 'now has no tags', not 'no data'", () => {
		completeTagScan({
			scope: WORKSPACE,
			files,
			scannedPaths: ["/w/one/b.md"],
			tags: {},
		});

		expect(tagsForScope(tagScanStore.get(), WORKSPACE)).toEqual({
			"/w/one/a.md": ["x"],
		});
	});

	it("drops paths that vanished from the workspace listing", () => {
		completeTagScan({
			scope: WORKSPACE,
			files: [fileA],
			scannedPaths: [],
			tags: {},
		});

		expect(tagsForScope(tagScanStore.get(), WORKSPACE)).toEqual({
			"/w/one/a.md": ["x"],
		});
	});
});

describe("upsertTagsForPath (defect 16/31, EC-66)", () => {
	beforeEach(() => {
		resetTagScan();
		beginTagScan(WORKSPACE);
		scanComplete({ "/w/one/a.md": ["x"], "/w/one/b.md": ["y"] });
	});

	it("upserts one path without touching any other document's tags", () => {
		upsertTagsForPath("/w/one/a.md", ["x", "new"]);

		expect(tagsForScope(tagScanStore.get(), WORKSPACE)).toEqual({
			"/w/one/a.md": ["x", "new"],
			"/w/one/b.md": ["y"],
		});
	});

	it("DELETES the entry on an empty list -- the scan shape cannot say this", () => {
		upsertTagsForPath("/w/one/a.md", []);

		expect(tagsForScope(tagScanStore.get(), WORKSPACE)).toEqual({
			"/w/one/b.md": ["y"],
		});
	});

	it("adds a path the scan never saw", () => {
		upsertTagsForPath("/w/one/c.md", ["z"]);

		expect(
			tagsForScope(tagScanStore.get(), WORKSPACE)?.["/w/one/c.md"],
		).toEqual(["z"]);
	});

	it("is inert while no map exists, so it can never fabricate a scanned state", () => {
		resetTagScan();
		upsertTagsForPath("/w/one/a.md", ["x"]);

		expect(tagScanStore.get()).toEqual({ kind: "idle" });
	});
});
