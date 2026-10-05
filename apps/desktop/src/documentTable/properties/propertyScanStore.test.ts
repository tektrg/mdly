import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrontMatterPropertyScan } from "../../desktopApi/types";
import {
	PROPERTY_SCAN_BATCH_SIZE,
	propertyScanStore,
	resetPropertyScan,
	runPropertyScan,
} from "./propertyScanStore";

const status = (value: string) => ({ type: "text" as const, value });

function fakeScanner(
	propertiesFor: (path: string) => FrontMatterPropertyScan["propertiesByPath"][string] | null,
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

describe("runPropertyScan", () => {
	it("reads everything once, then only files whose mtime moved", async () => {
		const scan = fakeScanner(() => ({ status: status("Todo") }));
		const files = [
			{ path: "/ws/a.md", modifiedAt: 1 },
			{ path: "/ws/b.md", modifiedAt: 1 },
		];
		await runPropertyScan("/ws", files, scan);
		expect(scan).toHaveBeenCalledTimes(1);
		expect(propertyScanStore.get().status).toBe("ready");
		expect(Object.keys(propertyScanStore.get().propertiesByPath)).toHaveLength(2);

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
		const scan = fakeScanner(() => (hasStatus ? { status: status("x") } : null));
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
