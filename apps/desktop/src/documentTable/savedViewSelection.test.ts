import type { ViewStore } from "@tektrg/table-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalStorageViewStore } from "./viewStores";

/** Saved views R3/R4: which saved view is selected, and what happens when it goes away. */

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

async function load(options: {
	persisted?: Record<string, unknown>;
	disk?: Disk;
	wrap?: (store: ViewStore) => ViewStore;
}) {
	vi.resetModules();
	vi.stubGlobal("localStorage", {
		getItem: vi.fn(() =>
			options.persisted
				? JSON.stringify({ workspace: options.persisted })
				: null,
		),
		setItem: vi.fn(),
	});
	const disk = options.disk ?? memoryStorage();
	const fileStore = await import("./documentViewsFileStore");
	fileStore.setViewStoreFactoryForTest((ws) => {
		const store = createLocalStorageViewStore(disk, ws);
		return options.wrap ? options.wrap(store) : store;
	});
	const tableStore = await import("./documentTableStore");
	const hidden = await import("./navHiddenViews");
	const state = await import("../store/state");
	return { ...fileStore, ...tableStore, ...hidden, ...state, disk };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("saved view selection (R3)", () => {
	it("remembers the selected saved view per workspace and restores it after restart", async () => {
		const m = await load({});
		m.workspacePathStore.set("/ws");
		await settle();
		const id = m.saveCurrentViewAs("Due") as string;
		await m.flushSavedViews("/ws");
		expect(m.workspaceStore.get().selectedSavedViews["/ws"]).toBe(id);

		// Restart: the file read is held back, so the first paint is built-ins only.
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const again = await load({
			disk: m.disk,
			persisted: { workspacePath: "/ws", selectedSavedViews: { "/ws": id } },
			wrap: (store) => ({
				...store,
				read: async () => {
					await gate;
					return store.read();
				},
			}),
		});
		// The test seam swaps the store after import, so start the open-time read here.
		const loading = again.loadWorkspaceSavedViews("/ws");
		await settle();
		// Built-ins-only first paint must not reset the selection.
		expect(again.documentTableViewStore.get().activeSavedViewId).toBe(id);
		expect(again.workspaceStore.get().selectedSavedViews["/ws"]).toBe(id);
		release();
		await loading;
		await settle();
		expect(again.getActiveSavedView()?.name).toBe("Due");
	});

	it("deleting the active saved view falls back to Recent and forgets it", async () => {
		const m = await load({});
		m.workspacePathStore.set("/ws");
		await settle();
		m.setDocumentTableGroupBy("folder");
		const id = m.saveCurrentViewAs("Due") as string;
		m.deleteSavedView(id);
		const session = m.documentTableViewStore.get();
		expect(session.activeSavedViewId).toBeNull();
		expect(session.groupBy).toBeNull();
		expect(m.workspaceStore.get().selectedSavedViews["/ws"]).toBeUndefined();
	});

	it("a selected view that no longer exists in the file falls back to Recent", async () => {
		const m = await load({
			persisted: {
				workspacePath: "/ws",
				selectedSavedViews: { "/ws": "gone" },
			},
		});
		await m.loadWorkspaceSavedViews("/ws");
		await settle();
		expect(m.documentTableViewStore.get().activeSavedViewId).toBeNull();
		expect(m.documentTableViewStore.get().groupBy).toBeNull();
		expect(m.workspaceStore.get().selectedSavedViews["/ws"]).toBeUndefined();
	});

	it("a corrupt file keeps the remembered selection (the view may come back)", async () => {
		const disk = memoryStorage();
		disk.map.set("mdly.savedViews.v1:/ws", "{bad");
		const m = await load({
			disk,
			persisted: { workspacePath: "/ws", selectedSavedViews: { "/ws": "x" } },
		});
		await m.loadWorkspaceSavedViews("/ws");
		await settle();
		expect(m.workspaceStore.get().selectedSavedViews["/ws"]).toBe("x");
	});

	it("selecting a built-in leaves the saved view and forgets it", async () => {
		const m = await load({});
		m.workspacePathStore.set("/ws");
		await settle();
		m.saveCurrentViewAs("Due");
		m.selectBuiltInView("recent");
		expect(m.documentTableViewStore.get().activeSavedViewId).toBeNull();
		expect(m.workspaceStore.get().selectedSavedViews["/ws"]).toBeUndefined();
		m.selectBuiltInView("tag");
		expect(m.documentTableViewStore.get().groupBy).toBe("tag");
	});

	it("each workspace keeps its own selection across a switch", async () => {
		const m = await load({});
		m.workspacePathStore.set("/a");
		await settle();
		const a = m.saveCurrentViewAs("A view");
		m.workspacePathStore.set("/b");
		await settle();
		expect(m.documentTableViewStore.get().activeSavedViewId).toBeNull();
		m.workspacePathStore.set("/a");
		await settle();
		await m.flushSavedViews("/a");
		expect(m.documentTableViewStore.get().activeSavedViewId).toBe(a);
	});
});

describe("hidden views never hold saved-view ids (R4)", () => {
	it("prunes stale / saved ids from the hidden-views setting", async () => {
		const m = await load({
			persisted: {
				workspacePath: "/ws",
				navHiddenViews: { "/ws": ["tag", "saved:abc", "abc"] },
			},
		});
		expect(m.getNavHiddenViews("/ws")).toEqual(["tag"]);
		expect(m.workspaceStore.get().navHiddenViews["/ws"]).toEqual(["tag"]);
	});
});
