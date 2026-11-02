import type { ViewStore, ViewsFile } from "@tektrg/table-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalStorageViewStore } from "./viewStores";

/** A Map-backed Storage: one per "disk", shared by every workspace key. */
function memoryStorage() {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
	};
}

type Disk = ReturnType<typeof memoryStorage>;
const fileKey = (ws: string) => `mdly.savedViews.v1:${ws}`;
const viewsOnDisk = (disk: Disk, ws: string) =>
	JSON.parse(disk.map.get(fileKey(ws)) ?? "null")?.views as
		| { id: string; name: string }[]
		| undefined;

/** Fresh module graph, with legacy localStorage contents for the app store. */
async function load(options: {
	legacy?: Record<string, unknown>;
	disk?: Disk;
	wrap?: (ws: string, store: ViewStore) => ViewStore;
}) {
	vi.resetModules();
	const appStorage = {
		getItem: vi.fn(() =>
			options.legacy
				? JSON.stringify({ workspace: { documentViews: options.legacy } })
				: null,
		),
		setItem: vi.fn(),
	};
	vi.stubGlobal("localStorage", appStorage);
	const disk = options.disk ?? memoryStorage();
	const fileStore = await import("./documentViewsFileStore");
	fileStore.setViewStoreFactoryForTest((ws) => {
		const store = createLocalStorageViewStore(disk, ws);
		return options.wrap ? options.wrap(ws, store) : store;
	});
	const tableStore = await import("./documentTableStore");
	const state = await import("../store/state");
	return { ...fileStore, ...tableStore, ...state, disk };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const legacyView = (id: string, name: string) => ({
	id,
	name,
	sort: { column: "modified", direction: "desc" },
	filters: [],
	groupBy: null,
	propertyColumns: [],
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("saved views file store (R11, R12, R20)", () => {
	it("saving a view writes it to that workspace's file; a reload reads it back", async () => {
		const m = await load({});
		m.workspacePathStore.set("/ws");
		await settle();
		const id = m.saveCurrentViewAs("Due work");
		await m.flushSavedViews("/ws");
		expect(viewsOnDisk(m.disk, "/ws")).toMatchObject([
			{ id, name: "Due work" },
		]);
		const again = await load({ disk: m.disk });
		again.workspacePathStore.set("/ws");
		await settle();
		await again.flushSavedViews("/ws");
		expect(again.getSavedViews("/ws").map((v) => v.name)).toEqual(["Due work"]);
	});

	it("each workspace sees only its own views", async () => {
		const m = await load({});
		m.workspacePathStore.set("/a");
		await settle();
		m.saveCurrentViewAs("Only A");
		m.workspacePathStore.set("/b");
		await settle();
		await m.flushAllSavedViews();
		expect(m.getSavedViews("/b")).toEqual([]);
		expect(viewsOnDisk(m.disk, "/a")?.map((v) => v.name)).toEqual(["Only A"]);
		expect(m.disk.map.has(fileKey("/b"))).toBe(false);
	});

	it("edits while a built-in view is active write nothing (R12)", async () => {
		const m = await load({});
		m.workspacePathStore.set("/ws");
		await settle();
		m.addPropertyFilter({ fieldId: "prop:status", kind: "has" });
		m.toggleDocumentTableSort("name");
		m.setPropertyGroupBy("prop:status");
		await m.flushAllSavedViews();
		expect(m.disk.map.size).toBe(0);
	});

	it("an edit inside the save delay is saved to the workspace it was made in on switch (R20)", async () => {
		const m = await load({});
		m.workspacePathStore.set("/a");
		await settle();
		m.saveCurrentViewAs("Mine");
		await m.flushSavedViews("/a");
		m.setDocumentTableSort({ column: "name", direction: "asc" });
		// Switch before the delay elapses.
		m.workspacePathStore.set("/b");
		await settle();
		await m.flushAllSavedViews();
		expect(
			JSON.parse(m.disk.map.get(fileKey("/a")) as string).views[0].sort,
		).toEqual({ column: "name", direction: "asc" });
		expect(m.disk.map.has(fileKey("/b"))).toBe(false);
	});

	it("switching away and straight back waits for the pending save before re-reading", async () => {
		const m = await load({
			wrap: (_ws, store) => ({
				read: store.read,
				write: async (file, snapshot) => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					return store.write(file, snapshot);
				},
			}),
		});
		m.workspacePathStore.set("/a");
		await settle();
		m.saveCurrentViewAs("First");
		await m.flushSavedViews("/a");
		m.saveCurrentViewAs("Second");
		m.workspacePathStore.set("/b");
		await Promise.resolve();
		m.workspacePathStore.set("/a");
		await new Promise((resolve) => setTimeout(resolve, 100));
		await m.flushAllSavedViews();
		expect(m.getWorkspaceSavedViews("/a")).toMatchObject({
			views: [{ name: "First" }, { name: "Second" }],
			notice: null,
		});
		expect(viewsOnDisk(m.disk, "/a")?.map((v) => v.name)).toEqual([
			"First",
			"Second",
		]);
	});

	it("rename and delete persist; rename rules reject blank / duplicate / built-in names", async () => {
		const m = await load({});
		m.workspacePathStore.set("/ws");
		await settle();
		const a = m.saveCurrentViewAs("Alpha") as string;
		const b = m.saveCurrentViewAs("Beta") as string;
		expect(m.saveCurrentViewAs("beta ")).toBeNull();
		expect(m.renameSavedView(a, "   ")).toEqual({ ok: false, reason: "empty" });
		expect(m.renameSavedView(a, "BETA")).toEqual({
			ok: false,
			reason: "duplicate",
		});
		expect(m.renameSavedView(a, "Recent")).toEqual({
			ok: false,
			reason: "builtin",
		});
		expect(m.renameSavedView(a, "x".repeat(61))).toEqual({
			ok: false,
			reason: "too_long",
		});
		expect(m.renameSavedView(a, "  Gamma ")).toEqual({
			ok: true,
			name: "Gamma",
		});
		m.deleteSavedView(a);
		await m.flushSavedViews("/ws");
		expect(viewsOnDisk(m.disk, "/ws")?.map((v) => v.name)).toEqual(["Beta"]);
		m.deleteSavedView(b);
		expect(m.documentTableViewStore.get().activeSavedViewId).toBeNull();
	});

	it("unknown fields and unusable entries survive a save (R14)", async () => {
		const disk = memoryStorage();
		disk.setItem(
			fileKey("/ws"),
			`${JSON.stringify({
				version: 1,
				future: { keep: true },
				views: [
					{ ...legacyView("v1", "Kept"), icon: "star" },
					{ id: "v2", name: "   " },
					{ nope: 1 },
				],
			})}\n`,
		);
		const m = await load({ disk });
		m.workspacePathStore.set("/ws");
		await settle();
		await m.flushSavedViews("/ws");
		expect(m.getSavedViews("/ws").map((v) => v.id)).toEqual(["v1"]);
		expect(m.getWorkspaceSavedViews("/ws").notice?.kind).toBe("skipped");
		m.renameSavedView("v1", "Renamed");
		await m.flushSavedViews("/ws");
		const saved = JSON.parse(disk.map.get(fileKey("/ws")) as string);
		expect(saved.future).toEqual({ keep: true });
		expect(saved.views[0]).toMatchObject({
			id: "v1",
			name: "Renamed",
			icon: "star",
		});
		expect(saved.views).toContainEqual({ id: "v2", name: "   " });
		expect(saved.views).toContainEqual({ nope: 1 });
	});
});

describe("corrupt / failing / conflicting file (R18, R19, R21)", () => {
	it("corrupt file: built-ins + notice, bytes untouched until an explicit save, which backs it up", async () => {
		const disk = memoryStorage();
		disk.setItem(fileKey("/ws"), "{bad");
		const m = await load({ disk });
		m.workspacePathStore.set("/ws");
		await settle();
		await m.flushSavedViews("/ws");
		expect(m.getWorkspaceSavedViews("/ws")).toMatchObject({
			status: "corrupt",
			views: [],
			notice: { kind: "corrupt" },
		});
		m.toggleDocumentTableSort("name");
		await m.flushAllSavedViews();
		expect(disk.map.get(fileKey("/ws"))).toBe("{bad");
		m.saveCurrentViewAs("Fresh");
		await m.flushSavedViews("/ws");
		const backups = [...disk.map.keys()].filter((k) => k.includes(".corrupt-"));
		expect(backups).toHaveLength(1);
		expect(disk.map.get(backups[0])).toBe("{bad");
		expect(viewsOnDisk(disk, "/ws")?.map((v) => v.name)).toEqual(["Fresh"]);
		expect(m.getWorkspaceSavedViews("/ws").status).toBe("ok");
	});

	it("a failed write keeps the edit in memory, shows an error, and does not retry", async () => {
		let writes = 0;
		const m = await load({
			wrap: (_ws, store) => ({
				read: store.read,
				write: async () => {
					writes += 1;
					return { status: "error", error: "EROFS" };
				},
			}),
		});
		m.workspacePathStore.set("/ws");
		await settle();
		m.saveCurrentViewAs("Stays");
		await m.flushSavedViews("/ws");
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(writes).toBe(1);
		expect(m.getWorkspaceSavedViews("/ws")).toMatchObject({
			views: [{ name: "Stays" }],
			notice: { kind: "write-error", error: "EROFS" },
			saveState: "error",
		});
	});

	it("a file changed on disk since it was read refuses the save, re-reads, and shows a conflict", async () => {
		const m = await load({});
		m.workspacePathStore.set("/ws");
		await settle();
		m.saveCurrentViewAs("Mine");
		await m.flushSavedViews("/ws");
		// Another window / Mac rewrites the file.
		m.disk.setItem(
			fileKey("/ws"),
			`${JSON.stringify({ version: 1, views: [legacyView("o", "Theirs")] })}\n`,
		);
		m.saveCurrentViewAs("Second");
		await m.flushSavedViews("/ws");
		expect(viewsOnDisk(m.disk, "/ws")?.map((v) => v.name)).toEqual(["Theirs"]);
		expect(m.getWorkspaceSavedViews("/ws")).toMatchObject({
			views: [{ name: "Theirs" }],
			notice: { kind: "conflict" },
		});
	});
});

describe("legacy localStorage migration (R15-R17)", () => {
	it("imports once into the opened workspace, clears only that legacy entry, keeps the rest", async () => {
		const m = await load({
			legacy: {
				"/a": {
					propertyColumns: ["prop:status"],
					saved: [legacyView("1", "One"), legacyView("2", "Recent")],
				},
				"/b": { propertyColumns: [], saved: [legacyView("3", "Other")] },
			},
		});
		m.workspacePathStore.set("/a");
		await settle();
		await m.flushSavedViews("/a");
		expect(viewsOnDisk(m.disk, "/a")?.map((v) => v.name)).toEqual([
			"One",
			"Recent 2",
		]);
		expect(m.getSavedViews("/a").map((v) => v.name)).toEqual([
			"One",
			"Recent 2",
		]);
		const legacy = m.workspaceStore.get().documentViews;
		expect(legacy["/a"]).toEqual({
			propertyColumns: ["prop:status"],
			saved: [],
		});
		expect(legacy["/b"]?.saved.map((v) => v.name)).toEqual(["Other"]);
		expect(m.disk.map.has(fileKey("/b"))).toBe(false);
	});

	it("keeps the remembered legacy view selected on the first open after upgrade (views.json missing)", async () => {
		vi.resetModules();
		vi.stubGlobal("localStorage", {
			getItem: vi.fn(() =>
				JSON.stringify({
					workspace: {
						documentViews: { "/a": { saved: [legacyView("1", "One")] } },
						selectedSavedViews: { "/a": "1" },
					},
				}),
			),
			setItem: vi.fn(),
		});
		const disk = memoryStorage();
		const fileStore = await import("./documentViewsFileStore");
		fileStore.setViewStoreFactoryForTest((ws) =>
			createLocalStorageViewStore(disk, ws),
		);
		const tableStore = await import("./documentTableStore");
		const state = await import("../store/state");
		state.workspacePathStore.set("/a");
		await settle();
		await fileStore.flushSavedViews("/a");
		await settle();
		expect(tableStore.getActiveSavedView()?.name).toBe("One");
		expect(state.workspaceStore.get().selectedSavedViews["/a"]).toBe("1");
	});

	it("merges into an existing file by id, file wins; re-running never duplicates", async () => {
		const disk = memoryStorage();
		disk.setItem(
			fileKey("/a"),
			`${JSON.stringify({ version: 1, views: [legacyView("1", "From file")] })}\n`,
		);
		const legacy = {
			"/a": { saved: [legacyView("1", "Legacy one"), legacyView("2", "Two")] },
		};
		const m = await load({ legacy, disk });
		m.workspacePathStore.set("/a");
		await settle();
		await m.flushSavedViews("/a");
		expect(viewsOnDisk(disk, "/a")?.map((v) => v.name)).toEqual([
			"From file",
			"Two",
		]);
		const bytes = disk.map.get(fileKey("/a"));
		const again = await load({ legacy, disk });
		again.workspacePathStore.set("/a");
		await settle();
		await again.flushSavedViews("/a");
		expect(disk.map.get(fileKey("/a"))).toBe(bytes);
	});

	it("a corrupt file or failed write keeps the legacy views for a later retry", async () => {
		const disk = memoryStorage();
		disk.setItem(fileKey("/a"), "{}");
		const legacy = { "/a": { saved: [legacyView("1", "One")] } };
		const m = await load({ legacy, disk });
		m.workspacePathStore.set("/a");
		await settle();
		await m.flushSavedViews("/a");
		expect(disk.map.get(fileKey("/a"))).toBe("{}");
		expect(m.workspaceStore.get().documentViews["/a"]?.saved).toHaveLength(1);

		const failing = await load({
			legacy,
			wrap: (_ws, store) => ({
				read: store.read,
				write: async () => ({ status: "error", error: "ENOENT" }),
			}),
		});
		failing.workspacePathStore.set("/a");
		await settle();
		await failing.flushSavedViews("/a");
		expect(
			failing.workspaceStore.get().documentViews["/a"]?.saved,
		).toHaveLength(1);
	});
});

describe("localStorage ViewStore (web, R25)", () => {
	it("is a strict, compare-and-swap ViewStore", async () => {
		const disk = memoryStorage();
		const store = createLocalStorageViewStore(disk, "/w");
		expect(await store.read()).toEqual({ status: "missing" });
		const file: ViewsFile = {
			version: 1,
			views: [{ id: "a", name: "A" }],
			invalidViews: [],
			extra: {},
		};
		const first = await store.write(file, null);
		expect(first.status).toBe("ok");
		expect((await store.write(file, null)).status).toBe("conflict");
		disk.setItem(fileKey("/w"), "{bad");
		expect((await store.read()).status).toBe("corrupt");
	});
});
