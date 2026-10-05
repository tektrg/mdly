import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrontMatterPropertyScan } from "../../desktopApi/types";
import {
	PROPERTY_SCAN_BATCH_SIZE,
	propertyScanStore,
	resetPropertyScan,
	runPropertyScan,
	scanStatusText,
} from "./propertyScanStore";

const status = (value: string) => ({ type: "text" as const, value });

function fakeScanner(
	propertiesFor: (
		path: string,
	) => FrontMatterPropertyScan["propertiesByPath"][string] | null,
	invalid: readonly string[] = [],
) {
	return vi.fn(async (paths: string[]): Promise<FrontMatterPropertyScan> => {
		const propertiesByPath: FrontMatterPropertyScan["propertiesByPath"] = {};
		for (const path of paths) {
			const properties = propertiesFor(path);
			if (properties) propertiesByPath[path] = properties;
		}
		return {
			propertiesByPath,
			invalidPaths: paths.filter((path) => invalid.includes(path)),
		};
	});
}

afterEach(() => resetPropertyScan());

describe("runPropertyScan stats bookkeeping", () => {
	it("does not retry an unreadable file until its mtime moves; a workspace switch releases stats", async () => {
		const scan = vi.fn(
			async (_paths: string[], options?: { includeStats?: boolean }) => ({
				propertiesByPath: {},
				invalidPaths: [],
				...(options?.includeStats ? { statsByPath: {} } : {}),
			}),
		);
		const files = [{ path: "/ws/locked.md", modifiedAt: 1 }];
		await runPropertyScan("/ws", files, scan, { includeStats: true });
		await runPropertyScan("/ws", files, scan, { includeStats: true });
		expect(scan).toHaveBeenCalledTimes(1);
		await runPropertyScan(
			"/ws",
			[{ path: "/ws/locked.md", modifiedAt: 2 }],
			scan,
			{ includeStats: true },
		);
		expect(scan).toHaveBeenCalledTimes(2);
		await runPropertyScan("/other", [], scan);
		const state = propertyScanStore.get();
		expect([
			state.includeStats,
			state.statsByPath,
			state.statsUnreadableMtimeByPath,
		]).toEqual([false, {}, {}]);
	});

	it("says when it is counting words", async () => {
		const base = {
			...propertyScanStore.get(),
			status: "scanning" as const,
			scannedCount: 5000,
			pendingCount: 50000,
		};
		expect(scanStatusText({ ...base, includeStats: true })).toBe(
			"Counting words… 5,000 / 50,000",
		);
		expect(scanStatusText({ ...base, includeStats: false })).toBe(
			"Reading front matter… 5,000 / 50,000",
		);
	});
});

describe("runPropertyScan", () => {
	it("reads whole files for stats only once a view asks, then only changed files", async () => {
		const scan = vi.fn(
			async (paths: string[], options?: { includeStats?: boolean }) => ({
				propertiesByPath: {},
				invalidPaths: [],
				...(options?.includeStats
					? {
							statsByPath: Object.fromEntries(
								paths.map((path) => [path, { sizeBytes: 10, wordCount: 2 }]),
							),
						}
					: {}),
			}),
		);
		const files = [
			{ path: "/ws/a.md", modifiedAt: 1 },
			{ path: "/ws/b.md", modifiedAt: 1 },
		];
		await runPropertyScan("/ws", files, scan);
		expect(scan).toHaveBeenLastCalledWith(["/ws/a.md", "/ws/b.md"]);
		// The view adds Word count: every file is read whole, once.
		await runPropertyScan("/ws", files, scan, { includeStats: true });
		expect(scan).toHaveBeenLastCalledWith(["/ws/a.md", "/ws/b.md"], {
			includeStats: true,
		});
		expect(Object.keys(propertyScanStore.get().statsByPath)).toHaveLength(2);
		await runPropertyScan("/ws", files, scan, { includeStats: true });
		expect(scan).toHaveBeenCalledTimes(2);
		// Sticky: a changed file is still counted after the column is hidden; a removed one is forgotten.
		await runPropertyScan("/ws", [{ path: "/ws/a.md", modifiedAt: 2 }], scan);
		expect(scan).toHaveBeenLastCalledWith(["/ws/a.md"], { includeStats: true });
		expect(Object.keys(propertyScanStore.get().statsByPath)).toEqual([
			"/ws/a.md",
		]);
	});

	it("reads everything once, then only files whose mtime moved", async () => {
		const scan = fakeScanner(() => ({ status: status("Todo") }));
		const files = [
			{ path: "/ws/a.md", modifiedAt: 1 },
			{ path: "/ws/b.md", modifiedAt: 1 },
		];
		await runPropertyScan("/ws", files, scan);
		expect(scan).toHaveBeenCalledTimes(1);
		expect(propertyScanStore.get().status).toBe("ready");
		expect(Object.keys(propertyScanStore.get().propertiesByPath)).toHaveLength(
			2,
		);

		// A refocus with the same listing reads zero heads.
		await runPropertyScan("/ws", files, scan);
		expect(scan).toHaveBeenCalledTimes(1);

		await runPropertyScan(
			"/ws",
			[files[0], { path: "/ws/b.md", modifiedAt: 2 }],
			scan,
		);
		expect(scan).toHaveBeenLastCalledWith(["/ws/b.md"]);
	});

	it("drops values removed from a file and paths removed from the workspace (renames)", async () => {
		let hasStatus = true;
		const scan = fakeScanner(() =>
			hasStatus ? { status: status("x") } : null,
		);
		await runPropertyScan(
			"/ws",
			[
				{ path: "/ws/a.md", modifiedAt: 1 },
				{ path: "/ws/old.md", modifiedAt: 1 },
			],
			scan,
		);
		hasStatus = false;
		// old.md renamed to new.md (new path, same mtime); a.md edited.
		await runPropertyScan(
			"/ws",
			[
				{ path: "/ws/a.md", modifiedAt: 2 },
				{ path: "/ws/new.md", modifiedAt: 1 },
			],
			scan,
		);
		const state = propertyScanStore.get();
		expect(state.propertiesByPath).toEqual({});
		expect(Object.keys(state.mtimeByPath).sort()).toEqual([
			"/ws/a.md",
			"/ws/new.md",
		]);
	});

	it("records malformed front matter, and clears it once fixed", async () => {
		let broken = true;
		const scan = vi.fn(async (paths: string[]) => ({
			propertiesByPath: {},
			invalidPaths: broken ? paths : [],
		}));
		await runPropertyScan("/ws", [{ path: "/ws/bad.md", modifiedAt: 1 }], scan);
		expect(propertyScanStore.get().invalidPaths).toEqual(["/ws/bad.md"]);
		broken = false;
		await runPropertyScan("/ws", [{ path: "/ws/bad.md", modifiedAt: 2 }], scan);
		expect(propertyScanStore.get().invalidPaths).toEqual([]);
	});

	it("batches large workspaces and drops a superseded workspace's late result", async () => {
		const files = Array.from(
			{ length: PROPERTY_SCAN_BATCH_SIZE + 1 },
			(_, index) => ({ path: `/ws/${index}.md`, modifiedAt: 1 }),
		);
		const scan = fakeScanner(() => ({ status: status("x") }));
		await runPropertyScan("/ws", files, scan);
		expect(scan).toHaveBeenCalledTimes(2);

		let release: () => void = () => {};
		const slow = vi.fn(
			(paths: string[]) =>
				new Promise<FrontMatterPropertyScan>((resolve) => {
					release = () =>
						resolve({
							propertiesByPath: Object.fromEntries(
								paths.map((path) => [path, { status: status("old") }]),
							),
							invalidPaths: [],
						});
				}),
		);
		const pending = runPropertyScan(
			"/first",
			[{ path: "/first/a.md", modifiedAt: 1 }],
			slow,
		);
		await runPropertyScan("/second", [], scan);
		release();
		await pending;
		expect(propertyScanStore.get().scope).toBe("/second");
		expect(propertyScanStore.get().propertiesByPath).toEqual({});
	});

	it("a superseding run of the same workspace keeps batches already read", async () => {
		const files = Array.from(
			{ length: PROPERTY_SCAN_BATCH_SIZE * 2 },
			(_, index) => ({ path: `/ws/${index}.md`, modifiedAt: 1 }),
		);
		const requested: number[] = [];
		let runSecond: () => Promise<void> = async () => {};
		const scan = vi.fn(async (paths: string[]) => {
			requested.push(paths.length);
			if (requested.length === 1) {
				// A save lands mid-scan and starts a newer run before batch 2.
				runSecond = () => runPropertyScan("/ws", files, plain);
			}
			return {
				propertiesByPath: Object.fromEntries(
					paths.map((path) => [path, { status: status("x") }]),
				),
				invalidPaths: [],
			};
		});
		const plain = vi.fn(scan);
		const first = runPropertyScan("/ws", files, async (paths) => {
			const result = await scan(paths);
			if (requested.length === 1) await runSecond();
			return result;
		});
		await first;
		// Batch 1 was read once; only batch 2 was read again by the newer run.
		expect(requested.reduce((sum, count) => sum + count, 0)).toBeLessThan(
			files.length * 2,
		);
		expect(Object.keys(propertyScanStore.get().propertiesByPath)).toHaveLength(
			files.length,
		);
	});

	it("reports a failed scan instead of an empty workspace", async () => {
		const scan = vi.fn(async () => {
			throw new Error("EACCES");
		});
		await runPropertyScan("/ws", [{ path: "/ws/a.md", modifiedAt: 1 }], scan);
		expect(propertyScanStore.get()).toMatchObject({
			status: "failed",
			failureMessage: "EACCES",
		});
	});
});
