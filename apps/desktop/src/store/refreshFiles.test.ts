import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopApi, loadStoreActions } from "./storeTestHarness";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
	toast: {
		warning: vi.fn(),
		error: toastError,
		success: vi.fn(),
		info: vi.fn(),
	},
}));

const LISTING = {
	files: [{ path: "/ws/a.md", modified_at: 1 }],
	folders: [],
};

describe("refreshFiles when the workspace cannot be read", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		toastError.mockClear();
	});

	// D3a: a network volume that blips for one listing used to replace a good
	// listing with `files: []`, so the document table silently emptied itself
	// and the rows only came back on the next successful refresh.
	it("keeps the listing already on screen when a later refresh fails", async () => {
		const api = createDesktopApi();
		api.listDirectory.mockResolvedValue(LISTING);
		const { openWorkspace, refreshFiles, workspaceStore } =
			await loadStoreActions(api);

		await openWorkspace("/ws");
		expect(workspaceStore.get().files).toHaveLength(1);

		api.listDirectory.mockRejectedValueOnce(new Error("EIO: volume went away"));
		await refreshFiles("/ws");

		expect(workspaceStore.get().files).toHaveLength(1);
		expect(workspaceStore.get().listingError).toContain("EIO");

		// A listing that works again clears the error.
		await refreshFiles("/ws");
		expect(workspaceStore.get().listingError).toBeNull();
	});

	// D3b: the failure toast used to be gated on an option only `openWorkspace`
	// passed, so the two refreshes that fire against a table already on screen —
	// the window-focus refresh and the menu's Sync — failed in total silence.
	it("tells the user every time a listing fails, not only on a workspace switch", async () => {
		const api = createDesktopApi();
		api.listDirectory.mockResolvedValue(LISTING);
		const { openWorkspace, refreshFiles } = await loadStoreActions(api);

		await openWorkspace("/ws");
		toastError.mockClear();

		api.listDirectory.mockRejectedValueOnce(new Error("EACCES: denied"));
		await refreshFiles("/ws");

		expect(toastError).toHaveBeenCalledTimes(1);
		expect(toastError.mock.calls[0]?.[1]?.description).toContain("EACCES");
	});

	// A watcher storm against an unreachable volume must not stack a toast per
	// event, so every listing failure reuses one toast id.
	it("collapses repeated failures into a single toast", async () => {
		const api = createDesktopApi();
		const { refreshFiles, workspaceStore } = await loadStoreActions(api);
		workspaceStore.set((state) => ({ ...state, workspacePath: "/ws" }));

		api.listDirectory.mockRejectedValue(new Error("EACCES: denied"));
		await refreshFiles("/ws");
		await refreshFiles("/ws");

		const toastIds = toastError.mock.calls.map((call) => call[1]?.id);
		expect(toastIds).toHaveLength(2);
		expect(toastIds[0]).toBeTruthy();
		expect(toastIds[1]).toBe(toastIds[0]);
	});
});
