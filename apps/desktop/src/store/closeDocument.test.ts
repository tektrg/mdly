import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopApi, loadStoreActions } from "./storeTestHarness";

const toastWarning = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
	toast: {
		warning: toastWarning,
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
	},
}));

describe("leaving the current document", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		toastWarning.mockClear();
	});

	// B1: R1 ("a workspace switch always lands on the table") removed the
	// `loadPath(lastFile)` tail that used to flush the outgoing document, so the
	// switch silently dropped whatever was still in the autosave debounce.
	it("saves the outgoing document's unsaved edits when the workspace switches", async () => {
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue("before");
		const { loadPath, openWorkspace, updateEditorContent } =
			await loadStoreActions(api);

		await openWorkspace("/ws");
		await loadPath("/ws/a.md");
		updateEditorContent("/ws/a.md", "UNSAVED TEXT");

		await openWorkspace("/other");

		expect(api.writeFileText).toHaveBeenCalledWith("/ws/a.md", "UNSAVED TEXT", {
			historyCause: "idle-session",
		});
	});

	// H2: without `loadPath.cancel()` on the workspace-switch door, a slow open
	// started in workspace A lands seconds later and snaps that document open on
	// top of workspace B's table.
	it("cancels an in-flight open so a late read cannot follow the user into the new workspace", async () => {
		const api = createDesktopApi();
		let finishRead: (content: string) => void = () => {};
		api.readFileText.mockReturnValue(
			new Promise<string>((resolve) => {
				finishRead = resolve;
			}),
		);
		const { loadPath, openWorkspace, viewerStore, workspaceStore } =
			await loadStoreActions(api);

		const slowOpen = loadPath("/ws/slow.md");
		await openWorkspace("/other");
		finishRead("# arrived too late");
		await slowOpen;

		expect(workspaceStore.get().workspacePath).toBe("/other");
		expect(viewerStore.get().requestedPath).toBeNull();
		expect(viewerStore.get().currentPath).toBeNull();
	});

	// H1: `clearViewer()` resets `externalChange` to "none", so a single Escape
	// used to throw away the only Undo for an auto-applied external change
	// without saying anything.
	it("tells the user when closing discards the Undo for an auto-applied external change", async () => {
		const api = createDesktopApi();
		const { appStore, closeDocumentToTable, viewerStore } =
			await loadStoreActions(api);
		const path = "/ws/note.md";
		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				requestedPath: path,
				currentPath: path,
				lastOpenedPath: path,
				content: "from disk",
				diskContent: "from disk",
				externalChange: { kind: "applied", previousContent: "my text" },
				status: "ready",
				error: null,
			},
		}));

		await closeDocumentToTable();

		expect(toastWarning).toHaveBeenCalledTimes(1);
		expect(toastWarning.mock.calls[0]?.[1]?.description).toContain("note.md");
		expect(viewerStore.get().externalChange).toEqual({ kind: "none" });
	});

	it("stays quiet when there is no pending external-change Undo to discard", async () => {
		const api = createDesktopApi();
		const { appStore, closeDocumentToTable } = await loadStoreActions(api);
		const path = "/ws/note.md";
		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				requestedPath: path,
				currentPath: path,
				lastOpenedPath: path,
				content: "from disk",
				diskContent: "from disk",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		await closeDocumentToTable();

		expect(toastWarning).not.toHaveBeenCalled();
	});

	// D6: the close's own flush re-reads the file. When the file changed on disk
	// in that window the preflight auto-applies the disk copy and returns without
	// writing, so the user's typing survives only as the Undo payload that
	// `clearViewer()` then destroys. The toast has to say that, not report a lost
	// "Undo".
	it("says the unsaved edits were discarded when a concurrent disk change swallows them", async () => {
		const api = createDesktopApi();
		// The disk copy changed under the editor while the user was typing.
		api.readFileText.mockResolvedValue("text from another app");
		const { appStore, closeDocumentToTable, viewerStore } =
			await loadStoreActions(api);
		const path = "/ws/note.md";
		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				requestedPath: path,
				currentPath: path,
				lastOpenedPath: path,
				content: "my unsaved typing",
				diskContent: "before",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		await closeDocumentToTable();

		// Proof the edits really were lost: the flush never wrote them.
		expect(api.writeFileText).not.toHaveBeenCalled();
		expect(viewerStore.get().currentPath).toBeNull();
		expect(toastWarning).toHaveBeenCalledTimes(1);
		const [title, options] = toastWarning.mock.calls[0] ?? [];
		expect(String(title).toLowerCase()).toContain("unsaved edits");
		expect(options?.description).toContain("note.md");
	});

	// M6: nothing called focus() on close, so Escape / "All documents" / Cmd+]
	// left focus on <body> and Tab restarted from the top of the window.
	//
	// D7: `openWorkspace` now leaves through this same door, so an unconditional
	// hand-off yanked focus onto a document row when the user switched workspaces
	// from the table with nothing open at all.
	it("hands focus back only when a document was actually open", async () => {
		const api = createDesktopApi();
		const {
			closeDocumentToTable,
			loadPath,
			openWorkspace,
			registerDocumentCloseFocus,
			viewerStore,
		} = await loadStoreActions(api);
		const currentPathWhenFocused: (string | null)[] = [];
		const unregister = registerDocumentCloseFocus(() => {
			currentPathWhenFocused.push(viewerStore.get().currentPath);
		});

		// Nothing open: a close (and a workspace switch from the table) must
		// leave focus where the user put it.
		await closeDocumentToTable();
		await openWorkspace("/ws");
		expect(currentPathWhenFocused).toEqual([]);

		api.readFileText.mockResolvedValue("# a");
		await loadPath("/ws/a.md");
		await closeDocumentToTable();

		// Still after `clearViewer()`, so the surface it focuses is already
		// rendering the cleared state.
		expect(currentPathWhenFocused).toEqual([null]);
		unregister();

		await loadPath("/ws/a.md");
		await closeDocumentToTable();
		expect(currentPathWhenFocused).toEqual([null]);
	});
});
