import type { ViewStore } from "@tektrg/table-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalStorageViewStore } from "./viewStores";

/** Per-view search-box text: separate per view, restored on switch, persisted (debounced). */

function memoryStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value);
		},
	};
}

async function load(persisted?: Record<string, unknown>) {
	vi.resetModules();
	vi.stubGlobal("localStorage", {
		getItem: vi.fn(() =>
			persisted ? JSON.stringify({ workspace: persisted }) : null,
		),
		setItem: vi.fn(),
	});
	const disk = memoryStorage();
	const fileStore = await import("./documentViewsFileStore");
	fileStore.setViewStoreFactoryForTest(
		(ws): ViewStore => createLocalStorageViewStore(disk, ws),
	);
	const tableStore = await import("./documentTableStore");
	const filters = await import("./navViewFilters");
	const state = await import("../store/state");
	const persistence = await import("../store/persistence");
	return { ...fileStore, ...tableStore, ...filters, ...state, persistence };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const filterOf = (m: Awaited<ReturnType<typeof load>>) =>
	m.documentTableViewStore.get().filter;

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("per-view search text", () => {
	it("keeps each view's text separate and restores it on switch", async () => {
		const m = await load();
		m.workspacePathStore.set("/ws");
		await settle();
		m.setDocumentTableFilter("alpha");
		m.selectBuiltInView("folder");
		expect(filterOf(m)).toBe("");
		m.setDocumentTableFilter("beta");
		m.selectBuiltInView("recent");
		expect(filterOf(m)).toBe("alpha");
		m.selectBuiltInView("folder");
		expect(filterOf(m)).toBe("beta");
		expect(m.workspaceStore.get().navViewFilters["/ws"]).toEqual({
			recent: "alpha",
			folder: "beta",
		});
	});

	it("debounces writes to storage while the box updates instantly", async () => {
		vi.useFakeTimers();
		const m = await load();
		m.workspacePathStore.set("/ws");
		m.setDocumentTableFilter("a");
		m.setDocumentTableFilter("ab");
		expect(filterOf(m)).toBe("ab");
		expect(m.workspaceStore.get().navViewFilters["/ws"]).toBeUndefined();
		vi.advanceTimersByTime(m.FILTER_PERSIST_DEBOUNCE_MS - 1);
		expect(m.workspaceStore.get().navViewFilters["/ws"]).toBeUndefined();
		vi.advanceTimersByTime(1);
		expect(m.workspaceStore.get().navViewFilters["/ws"]).toEqual({
			recent: "ab",
		});
	});

	it("survives a reload through local storage", async () => {
		vi.useFakeTimers();
		const first = await load();
		first.workspacePathStore.set("/ws");
		first.setDocumentTableFilter("*.md");
		vi.advanceTimersByTime(first.FILTER_PERSIST_DEBOUNCE_MS);
		const written = first.persistence.serialize({
			...first.persistence.getInitialState(),
			workspace: first.workspaceStore.get(),
		}) as { workspace: Record<string, unknown> };
		vi.useRealTimers();
		const m = await load({ ...written.workspace, workspacePath: "/ws" });
		expect(filterOf(m)).toBe("*.md");
	});

	it("drops the text of deleted saved views only", async () => {
		const m = await load();
		m.workspacePathStore.set("/ws");
		await settle();
		m.setDocumentTableFilter("keep");
		const id = m.saveCurrentViewAs("Due") as string;
		expect(m.getNavViewFilter("/ws", `saved:${id}`)).toBe("keep");
		m.deleteSavedView(id);
		await m.flushSavedViews("/ws");
		await settle();
		expect(m.getNavViewFilter("/ws", `saved:${id}`)).toBe("");
		expect(m.getNavViewFilter("/ws", "recent")).toBe("keep");
	});

	it("drops malformed entries on load", async () => {
		const m = await load();
		expect(
			m.persistence.sanitizeNavViewFilters({
				"/ws": { recent: "x", tag: 3, folder: "" },
			}),
		).toEqual({ "/ws": { recent: "x" } });
	});
});
