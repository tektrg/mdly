// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalStorageViewStore } from "./viewStores";

afterEach(() => {
	vi.unstubAllGlobals();
	(window as { desktopApi?: unknown }).desktopApi = undefined;
});

describe("quit flush handshake (saved views R20)", () => {
	it("registers with main and, when asked, writes an edit still inside the save delay", async () => {
		vi.resetModules();
		let flush: (() => Promise<void>) | null = null;
		(window as { desktopApi?: unknown }).desktopApi = {
			onFlushPendingSaves: (callback: () => Promise<void>) => {
				flush = callback;
				return () => {};
			},
		};
		const map = new Map<string, string>();
		const disk = {
			getItem: (k: string) => map.get(k) ?? null,
			setItem: (k: string, v: string) => void map.set(k, v),
		};
		const fileStore = await import("./documentViewsFileStore");
		fileStore.setViewStoreFactoryForTest((ws) =>
			createLocalStorageViewStore(disk, ws),
		);
		const tableStore = await import("./documentTableStore");
		const state = await import("../store/state");
		state.workspacePathStore.set("/ws");
		await fileStore.loadWorkspaceSavedViews("/ws");

		expect(flush).not.toBeNull();
		tableStore.saveCurrentViewAs("Late edit");
		// Still inside the save delay: nothing on disk yet.
		expect(map.get("mdly.savedViews.v1:/ws")).toBeUndefined();
		await (flush as unknown as () => Promise<void>)();
		expect(map.get("mdly.savedViews.v1:/ws")).toContain("Late edit");
	});
});
