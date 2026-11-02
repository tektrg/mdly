import { afterEach, describe, expect, it, vi } from "vitest";

async function load() {
	vi.resetModules();
	vi.stubGlobal("localStorage", {
		getItem: vi.fn(() => null),
		setItem: vi.fn(),
	});
	const tableStore = await import("./documentTableStore");
	const state = await import("../store/state");
	const { getSavedViews } = await import("./documentViewsFileStore");
	const m = { ...tableStore, ...state, getSavedViews };
	m.workspacePathStore.set("/ws");
	await new Promise((resolve) => setTimeout(resolve, 0));
	return m;
}

describe("undo delete saved view", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("restores the same view at its original position and re-selects it when it was active", async () => {
		const m = await load();
		const a = m.saveCurrentViewAs("A") as string;
		const b = m.saveCurrentViewAs("B") as string;
		const c = m.saveCurrentViewAs("C") as string;
		m.selectSavedView(b);
		const before = m.getSavedViews("/ws");

		const undo = m.deleteSavedView(b);
		expect(m.getSavedViews("/ws").map((v) => v.id)).toEqual([a, c]);
		expect(m.documentTableViewStore.get().activeSavedViewId).toBeNull();

		expect(undo?.()).toBe(true);
		expect(m.getSavedViews("/ws")).toEqual(before);
		expect(m.documentTableViewStore.get().activeSavedViewId).toBe(b);
		expect(m.workspaceStore.get().selectedSavedViews["/ws"]).toBe(b);
	});

	it("does not select a restored view that was not active", async () => {
		const m = await load();
		const a = m.saveCurrentViewAs("A") as string;
		m.saveCurrentViewAs("B");
		m.selectSavedView(null);
		const undo = m.deleteSavedView(a);
		expect(undo?.()).toBe(true);
		expect(m.getSavedViews("/ws")[0]?.id).toBe(a);
		expect(m.documentTableViewStore.get().activeSavedViewId).toBeNull();
	});

	it("only the latest delete can be undone", async () => {
		const m = await load();
		const a = m.saveCurrentViewAs("A") as string;
		const b = m.saveCurrentViewAs("B") as string;
		const undoA = m.deleteSavedView(a);
		const undoB = m.deleteSavedView(b);
		expect(undoA?.()).toBe(false);
		expect(undoB?.()).toBe(true);
		expect(m.getSavedViews("/ws").map((v) => v.id)).toEqual([b]);
		expect(undoB?.()).toBe(false);
	});

	it("never writes into another workspace after a switch", async () => {
		const m = await load();
		const a = m.saveCurrentViewAs("A") as string;
		const undo = m.deleteSavedView(a);
		m.workspacePathStore.set("/other");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(undo?.()).toBe(false);
		expect(m.getSavedViews("/other")).toEqual([]);
		expect(m.getSavedViews("/ws")).toEqual([]);
	});

	it("returns null for an unknown id", async () => {
		const m = await load();
		expect(m.deleteSavedView("nope")).toBeNull();
	});
});
