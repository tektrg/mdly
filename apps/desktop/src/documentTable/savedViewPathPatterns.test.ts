/**
 * Path patterns + path groupings in saved views: the `views.json` round-trip
 * (mdly keys `pathFilters` / `groupByKind` beside table-core's record), the
 * engine's AND-across / OR-within rule, the live filter box's pattern mode,
 * and the Folder / Top-level folder / Tag group order.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	createWorkspaceViewStore,
	viewsFilePath,
} from "@tektrg/table-core/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "../store/state";
import {
	evaluateDocumentRowsForTest,
	filterAndSortDocumentRows,
} from "./documentTableEngine";
import {
	buildDocumentRows,
	createDefaultDocumentTableView,
	type DocumentTableView,
	resetDocumentRowsMemo,
} from "./documentTableView";
import type { NavDocument } from "./navGroupTree";
import {
	PATH_GROUP_BY,
	sanitizeSavedView,
	savedViewToRecord,
} from "./properties/documentViews";
import { buildPathGroupTree } from "./properties/pathGroupTree";

const WS = "/ws";
const file = (rel: string): FileEntry =>
	({ path: `${WS}/${rel}`, modified_at: 1, is_symlink: false }) as FileEntry;
const FILES = [
	"memory/a/note.md",
	"memory/b.md",
	"docs/API-Spec.md",
	"docs/readme.md",
	"root.md",
].map(file);

function names(view: Partial<DocumentTableView>): string[] {
	resetDocumentRowsMemo();
	const rows = buildDocumentRows(FILES, WS);
	const full = {
		...createDefaultDocumentTableView(),
		sort: { column: "name" as const, direction: "asc" as const },
		...view,
	};
	const fast = filterAndSortDocumentRows(rows, full);
	// The optimized path and the one-evaluate reference agree.
	expect(evaluateDocumentRowsForTest(rows, full)).toEqual(fast);
	return fast.map((row) => row.path.slice(WS.length + 1)).sort();
}

describe("path filter in views", () => {
	it("matches folder/sub/file.md; entries and chips OR-ed", () => {
		expect(
			names({ propertyFilters: [{ kind: "path", pattern: "memory/*" }] }),
		).toEqual(["memory/a/note.md", "memory/b.md"]);
		expect(
			names({
				propertyFilters: [{ kind: "path", pattern: "*spec*.md, root" }],
			}),
		).toEqual(["docs/API-Spec.md", "root.md"]);
		expect(
			names({
				propertyFilters: [
					{ kind: "path", pattern: "/^docs\\/r/" },
					{ kind: "path", pattern: "b.md" },
				],
			}),
		).toEqual(["docs/readme.md", "memory/b.md"]);
	});

	it("is AND-ed with folder chips; a broken regex matches nothing", () => {
		expect(
			names({
				propertyFilters: [
					{ kind: "folder", path: "memory" },
					{ kind: "path", pattern: "*note*" },
				],
			}),
		).toEqual(["memory/a/note.md"]);
		expect(
			names({ propertyFilters: [{ kind: "path", pattern: "/[/" }] }),
		).toEqual([]);
	});
});

describe("live filter box", () => {
	it("plain text stays a file-name substring (folder names do not widen)", () => {
		expect(names({ filter: "memory" })).toEqual([]);
		expect(names({ filter: "READ" })).toEqual(["docs/readme.md"]);
	});
	it("`*` or /…/ switches to a pattern over the full path", () => {
		expect(names({ filter: "memory/*" })).toEqual([
			"memory/a/note.md",
			"memory/b.md",
		]);
		expect(names({ filter: "/^docs/" })).toEqual([
			"docs/API-Spec.md",
			"docs/readme.md",
		]);
		expect(names({ filter: "/[/" })).toEqual([]);
	});
});

describe("record round-trip", () => {
	it("path chips and path grouping persist as mdly keys, old records unchanged", () => {
		const base = sanitizeSavedView({ id: "v", name: "V" });
		if (!base) throw new Error("sanitize");
		const view = {
			...base,
			filters: [
				...base.filters,
				{ kind: "path" as const, pattern: "memory/*" },
			],
			groupBy: PATH_GROUP_BY.topFolder,
		};
		const record = JSON.parse(JSON.stringify(savedViewToRecord(view)));
		expect(record).toMatchObject({
			filters: [],
			groupBy: null,
			pathFilters: ["memory/*"],
			groupByKind: "topFolder",
		});
		expect(sanitizeSavedView(record)).toEqual(view);
		expect(JSON.parse(JSON.stringify(savedViewToRecord(base)))).toEqual(
			JSON.parse(JSON.stringify(base)),
		);
	});
});

let ws: string;
describe("external views.json", () => {
	beforeEach(async () => {
		ws = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), "mdly-path-views-")),
		);
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		await fs.rm(ws, { recursive: true, force: true });
	});

	it("loads pathFilters/groupByKind, keeps unknown keys, re-saves them", async () => {
		await fs.mkdir(path.join(ws, ".hubble"));
		await fs.writeFile(
			viewsFilePath(ws),
			JSON.stringify({
				version: 1,
				views: [
					{
						id: "p",
						name: "Specs",
						filters: [{ kind: "folder", path: "docs" }],
						pathFilters: ["*spec*.md, /x/"],
						groupBy: null,
						groupByKind: "tag",
						futureKey: 1,
					},
				],
			}),
		);
		vi.resetModules();
		vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
		const fileStore = await import("./documentViewsFileStore");
		fileStore.setViewStoreFactoryForTest((root) =>
			createWorkspaceViewStore(root),
		);
		const state = await import("../store/state");
		state.workspacePathStore.set(ws);
		for (let i = 0; i < 200; i += 1) {
			if (fileStore.getWorkspaceSavedViews(ws).status !== "loading") break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const [view] = fileStore.getSavedViews(ws);
		expect(view.filters).toEqual([
			{ kind: "folder", path: "docs" },
			{ kind: "path", pattern: "*spec*.md, /x/" },
		]);
		expect(view.groupBy).toBe(PATH_GROUP_BY.tag);
		fileStore.updateSavedViews(ws, (views) =>
			views.map((v) => ({
				...v,
				filters: v.filters.filter((f) => f.kind !== "path"),
				groupBy: PATH_GROUP_BY.folder,
			})),
		);
		await fileStore.flushSavedViews(ws);
		const saved = JSON.parse(await fs.readFile(viewsFilePath(ws), "utf8"))
			.views[0];
		expect(saved.pathFilters).toBeUndefined();
		expect(saved.groupByKind).toBe("folder");
		expect(saved.futureKey).toBe(1);
		expect(saved.filters).toEqual([{ kind: "folder", path: "docs" }]);
	});
});

describe("path group tree", () => {
	const doc = (
		p: string,
		folderPath: string,
		tags?: string[],
	): NavDocument => ({
		path: p,
		folderPath,
		tags,
	});
	const DOCS = [
		doc("1", "b/x", ["t1", "t2"]),
		doc("2", "b/y", ["t2"]),
		doc("3", "a", ["t2", "t2"]),
		doc("4", "", []),
		doc("5", "c"),
	];
	const groups = (by: (typeof PATH_GROUP_BY)[keyof typeof PATH_GROUP_BY]) =>
		buildPathGroupTree(DOCS, by).children.map(
			(g) => `${g.label}:${g.members.size}`,
		);

	it("Folder: biggest first, then A→Z, Other last", () => {
		expect(groups(PATH_GROUP_BY.folder)).toEqual([
			"a:1",
			"b/x:1",
			"b/y:1",
			"c:1",
			"Other:1",
		]);
	});
	it("Top-level folder: first segment", () => {
		expect(groups(PATH_GROUP_BY.topFolder)).toEqual([
			"b:2",
			"a:1",
			"c:1",
			"Other:1",
		]);
	});
	it("Tag: a multi-tag doc is in each group; untagged go to Other", () => {
		expect(groups(PATH_GROUP_BY.tag)).toEqual(["t2:3", "t1:1", "Other:2"]);
	});
	it("empty input has no groups", () => {
		expect(buildPathGroupTree([], PATH_GROUP_BY.tag).children).toEqual([]);
	});
});
