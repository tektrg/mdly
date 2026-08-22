import { beforeEach, describe, expect, it, vi } from "vitest";

type MockDesktopApi = {
	readFileText: ReturnType<typeof vi.fn>;
	writeFileText: ReturnType<typeof vi.fn>;
	listDirectory: ReturnType<typeof vi.fn>;
	readWorkspaceConfig: ReturnType<typeof vi.fn>;
	writeWorkspaceConfig: ReturnType<typeof vi.fn>;
	renameFile: ReturnType<typeof vi.fn>;
	renameSymlinkTarget: ReturnType<typeof vi.fn>;
	pathExists: ReturnType<typeof vi.fn>;
	openFolderPicker: ReturnType<typeof vi.fn>;
	deleteFile: ReturnType<typeof vi.fn>;
};

function createDesktopApi(): MockDesktopApi {
	return {
		readFileText: vi.fn(async () => "before"),
		writeFileText: vi.fn(async () => {}),
		listDirectory: vi.fn(async () => ({ files: [], folders: [] })),
		readWorkspaceConfig: vi.fn(async () => ({ version: 1, pinnedNotes: [] })),
		writeWorkspaceConfig: vi.fn(async () => {}),
		renameFile: vi.fn(async () => {}),
		renameSymlinkTarget: vi.fn(async () => {}),
		pathExists: vi.fn(async () => false),
		openFolderPicker: vi.fn(async () => undefined),
		deleteFile: vi.fn(async () => {}),
	};
}

/**
 * Actions capture window.desktopApi at import time, so each test stubs globals
 * before importing the store modules.
 */
async function loadStoreActions(api: MockDesktopApi, persisted?: unknown) {
	vi.resetModules();
	vi.stubGlobal("localStorage", {
		getItem: vi.fn(() => (persisted ? JSON.stringify(persisted) : null)),
		setItem: vi.fn(),
	});
	vi.stubGlobal("window", {
		desktopApi: api,
		setTimeout,
		clearTimeout,
	});

	const actions = await import("./actions");
	const state = await import("./state");
	return { ...actions, ...state };
}

describe("desktop savePathContent", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("preserves newer editor content when an older save finishes", async () => {
		const api = createDesktopApi();
		let finishWrite: () => void = () => {};
		// Keep the disk write pending so we can simulate more typing before the
		// older save resolves back into the store.
		api.writeFileText.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishWrite = resolve;
				}),
		);
		const { appStore, savePathContent, updateEditorContent, viewerStore } =
			await loadStoreActions(api);
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: "draft 1",
				diskContent: "before",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		const save = savePathContent(path, "draft 1");
		await Promise.resolve();
		expect(api.writeFileText).toHaveBeenCalledWith(path, "draft 1");

		updateEditorContent(path, "draft 2");
		finishWrite();
		await save;

		expect(viewerStore.get().content).toBe("draft 2");
		expect(viewerStore.get().diskContent).toBe("draft 1");
		expect(viewerStore.get().externalChange).toEqual({ kind: "none" });
	});

	it("uses latest editor content when classifying disk changes", async () => {
		const api = createDesktopApi();
		// The file now matches what the user just typed, even though the save
		// that is finishing still has the older text.
		api.readFileText.mockResolvedValue("draft 2");
		const { appStore, savePathContent, updateEditorContent, viewerStore } =
			await loadStoreActions(api);
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: "draft 1",
				diskContent: "before",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));
		updateEditorContent(path, "draft 2");

		await savePathContent(path, "draft 1");

		expect(api.writeFileText).not.toHaveBeenCalled();
		expect(viewerStore.get().content).toBe("draft 2");
		expect(viewerStore.get().diskContent).toBe("draft 2");
		expect(viewerStore.get().externalChange).toEqual({ kind: "none" });
	});

	it("does not let an automatic idle/forced history cut silently win an unresolved external-change conflict", async () => {
		const api = createDesktopApi();
		const { appStore, savePathContent, viewerStore } =
			await loadStoreActions(api);
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: "my local edit",
				diskContent: "before",
				externalChange: { kind: "conflict", diskContent: "changed outside" },
				status: "ready",
				error: null,
			},
		}));

		// The idle/forced cut always calls savePathContent with force: true and
		// a historyCause, exactly like DocumentViewer's handleIdleOrForcedCut.
		await savePathContent(path, "my local edit", {
			force: true,
			historyCause: "idle-session",
		});

		expect(api.writeFileText).not.toHaveBeenCalled();
		expect(viewerStore.get().externalChange).toEqual({
			kind: "conflict",
			diskContent: "changed outside",
		});

		// Resolving the conflict through "Keep My Edits" (force: true, no
		// historyCause) still works exactly as before this fix.
		await savePathContent(path, "my local edit", { force: true });
		expect(api.writeFileText).toHaveBeenCalledWith(path, "my local edit");
		expect(viewerStore.get().externalChange).toEqual({ kind: "none" });

		// Once resolved, a subsequent idle/forced cut behaves normally again.
		api.writeFileText.mockClear();
		await savePathContent(path, "later edit", {
			force: true,
			historyCause: "idle-session",
		});
		expect(api.writeFileText).toHaveBeenCalledWith(path, "later edit", {
			historyCause: "idle-session",
		});
	});

	it("does not let an automatic idle/forced history cut silently win a pending review either (QA1c, R22)", async () => {
		const api = createDesktopApi();
		const { appStore, savePathContent, viewerStore } =
			await loadStoreActions(api);
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: "my local edit",
				diskContent: "before",
				externalChange: { kind: "review", diskContent: "changed outside" },
				status: "ready",
				error: null,
			},
		}));

		// Before the "review" kind existed, this same call only special-cased
		// "conflict" here, so a pending review would have bypassed the `if
		// (!force)` preflight entirely and silently overwritten the disk's
		// reviewed external content with stale local text.
		await savePathContent(path, "my local edit", {
			force: true,
			historyCause: "idle-session",
		});

		expect(api.writeFileText).not.toHaveBeenCalled();
		expect(viewerStore.get().externalChange).toEqual({
			kind: "review",
			diskContent: "changed outside",
		});
	});
});

describe("desktop external change review", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("classifies a clean external edit as a pending review, not a silent reload (R1)", async () => {
		const api = createDesktopApi();
		const { appStore, handleExternalFileChange, viewerStore } =
			await loadStoreActions(api);
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: "original",
				diskContent: "original",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		handleExternalFileChange(path, "original\n\nexternal edit");

		// The editor's visible content is untouched until the user acts on it.
		expect(viewerStore.get().content).toBe("original");
		expect(viewerStore.get().diskContent).toBe("original");
		expect(viewerStore.get().externalChange).toEqual({
			kind: "review",
			diskContent: "original\n\nexternal edit",
		});
	});

	it("refreshes a pending review to the cumulative change when a second external edit lands (R11)", async () => {
		const api = createDesktopApi();
		const { appStore, handleExternalFileChange, viewerStore } =
			await loadStoreActions(api);
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: "original",
				diskContent: "original",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		handleExternalFileChange(path, "original\n\nfirst edit");
		expect(viewerStore.get().externalChange).toEqual({
			kind: "review",
			diskContent: "original\n\nfirst edit",
		});

		handleExternalFileChange(path, "original\n\nfirst edit\n\nsecond edit");

		expect(viewerStore.get().content).toBe("original");
		expect(viewerStore.get().externalChange).toEqual({
			kind: "review",
			diskContent: "original\n\nfirst edit\n\nsecond edit",
		});
	});

	it("clears a stale pending review when a second external write restores the original content (R32)", async () => {
		const api = createDesktopApi();
		const { appStore, handleExternalFileChange, viewerStore } =
			await loadStoreActions(api);
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: "original",
				diskContent: "original",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		handleExternalFileChange(path, "original\n\nexternal edit");
		expect(viewerStore.get().externalChange.kind).toBe("review");

		// The external tool undoes its own edit, restoring the exact pre-review
		// bytes — nothing is left to review.
		handleExternalFileChange(path, "original");

		expect(viewerStore.get().externalChange).toEqual({ kind: "none" });
	});

	it("keeps silently reloading non-Markdown files instead of raising a review badge (R15)", async () => {
		const api = createDesktopApi();
		const { appStore, handleExternalFileChange, viewerStore } =
			await loadStoreActions(api);
		const path = "/workspace/notes.txt";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: "original",
				diskContent: "original",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		handleExternalFileChange(path, "original\n\nexternal edit");

		// Exactly the pre-Slice-3 silent-swap behavior: no badge, content
		// updates immediately.
		expect(viewerStore.get().externalChange).toEqual({ kind: "none" });
		expect(viewerStore.get().content).toBe("original\n\nexternal edit");
		expect(viewerStore.get().diskContent).toBe("original\n\nexternal edit");
	});

	it("scopes the pending review to the path it belongs to, not whatever is currently open (R27)", async () => {
		const api = createDesktopApi();
		const { appStore, handleExternalFileChange, viewerStore } =
			await loadStoreActions(api);
		const openPath = "/workspace/open.md";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: openPath,
				lastOpenedPath: openPath,
				content: "open content",
				diskContent: "open content",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		handleExternalFileChange("/workspace/other.md", "unrelated change");

		expect(viewerStore.get().currentPath).toBe(openPath);
		expect(viewerStore.get().externalChange).toEqual({ kind: "none" });
	});

	describe("resolveExternalChangeReview", () => {
		function setPendingReview(
			appStore: Awaited<ReturnType<typeof loadStoreActions>>["appStore"],
			path: string,
			{
				content = "original",
				diskContent = "original\n\nexternal edit",
			}: { content?: string; diskContent?: string } = {},
		) {
			appStore.set((current) => ({
				...current,
				document: {
					...current.document,
					currentPath: path,
					lastOpenedPath: path,
					content,
					diskContent: content,
					externalChange: { kind: "review", diskContent },
					status: "ready",
					error: null,
				},
			}));
		}

		it("writes the merged text tagged 'manual' and clears the review on success (R6, R7)", async () => {
			const api = createDesktopApi();
			const externalEditText = "original\n\nexternal edit";
			api.readFileText.mockResolvedValue(externalEditText);
			const { appStore, resolveExternalChangeReview, viewerStore } =
				await loadStoreActions(api);
			const path = "/workspace/note.md";
			setPendingReview(appStore, path, { diskContent: externalEditText });

			const mergedText = "original\n\naccepted region";
			const applied = await resolveExternalChangeReview(mergedText);

			expect(applied).toBe(true);
			expect(api.writeFileText).toHaveBeenCalledWith(path, mergedText, {
				historyCause: "manual",
			});
			expect(viewerStore.get().content).toBe(mergedText);
			expect(viewerStore.get().diskContent).toBe(mergedText);
			expect(viewerStore.get().externalChange).toEqual({ kind: "none" });
		});

		it("does not silently discard local edits typed while the review badge was showing (Blocker 3)", async () => {
			const api = createDesktopApi();
			const externalEditText = "original\n\nexternal edit";
			api.readFileText.mockResolvedValue(externalEditText);
			const { appStore, resolveExternalChangeReview, viewerStore } =
				await loadStoreActions(api);
			const path = "/workspace/note.md";
			setPendingReview(appStore, path, { diskContent: externalEditText });

			// The editor stays live while the badge is showing -- simulate the
			// user typing more into it without the frozen baseline (diskContent)
			// moving.
			appStore.set((current) => ({
				...current,
				document: {
					...current.document,
					content: "original\n\nlocally typed edit",
				},
			}));

			const applied = await resolveExternalChangeReview(
				"original\n\naccepted region",
			);

			expect(applied).toBe(false);
			expect(api.writeFileText).not.toHaveBeenCalled();
			// Neither the pending review nor the user's local typing is discarded.
			expect(viewerStore.get().externalChange).toEqual({
				kind: "review",
				diskContent: externalEditText,
			});
			expect(viewerStore.get().content).toBe("original\n\nlocally typed edit");
		});

		it("preserves the pending review and surfaces an error when the write-back fails (R23, QA2a)", async () => {
			const api = createDesktopApi();
			const externalEditText = "original\n\nexternal edit";
			api.readFileText.mockResolvedValue(externalEditText);
			api.writeFileText.mockRejectedValue(new Error("disk full"));
			const { appStore, resolveExternalChangeReview, viewerStore } =
				await loadStoreActions(api);
			const path = "/workspace/note.md";
			setPendingReview(appStore, path, { diskContent: externalEditText });

			await resolveExternalChangeReview("original\n\naccepted region");

			// The picks are not silently discarded — the pending review is exactly
			// as it was, available to retry.
			expect(viewerStore.get().externalChange).toEqual({
				kind: "review",
				diskContent: externalEditText,
			});
			expect(viewerStore.get().content).toBe("original");
		});

		it("does not clobber a third writer's edit that lands during the write-back window (R24, QA5a)", async () => {
			const api = createDesktopApi();
			const externalEditText = "original\n\nexternal edit";
			const raceContent = "original\n\na third writer's edit";
			// The disk no longer holds what the merge was computed against by the
			// time resolveExternalChangeReview re-checks it.
			api.readFileText.mockResolvedValue(raceContent);
			const { appStore, resolveExternalChangeReview, viewerStore } =
				await loadStoreActions(api);
			const path = "/workspace/note.md";
			setPendingReview(appStore, path, { diskContent: externalEditText });

			await resolveExternalChangeReview("original\n\naccepted region");

			expect(api.writeFileText).not.toHaveBeenCalled();
			// Re-pointed at the newer disk content instead of being silently
			// overwritten.
			expect(viewerStore.get().externalChange).toEqual({
				kind: "review",
				diskContent: raceContent,
			});
			expect(viewerStore.get().content).toBe("original");
		});

		it("is a no-op when there is no pending review to resolve", async () => {
			const api = createDesktopApi();
			const { appStore, resolveExternalChangeReview, viewerStore } =
				await loadStoreActions(api);
			const path = "/workspace/note.md";

			appStore.set((current) => ({
				...current,
				document: {
					...current.document,
					currentPath: path,
					lastOpenedPath: path,
					content: "original",
					diskContent: "original",
					externalChange: { kind: "none" },
					status: "ready",
					error: null,
				},
			}));

			await resolveExternalChangeReview("whatever");

			expect(api.writeFileText).not.toHaveBeenCalled();
			expect(viewerStore.get().externalChange).toEqual({ kind: "none" });
		});

		it("does not let its own write-back echo re-open the just-resolved review (R12, QA1a)", async () => {
			const api = createDesktopApi();
			const externalEditText = "original\n\nexternal edit";
			const mergedText = "original\n\naccepted region";
			api.readFileText.mockResolvedValue(externalEditText);
			let finishWrite: () => void = () => {};
			api.writeFileText.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						finishWrite = resolve;
					}),
			);
			const {
				appStore,
				resolveExternalChangeReview,
				handleExternalFileChange,
				viewerStore,
			} = await loadStoreActions(api);
			const path = "/workspace/note.md";
			setPendingReview(appStore, path, { diskContent: externalEditText });

			const resolve = resolveExternalChangeReview(mergedText);
			// pendingSelfWrite is recorded synchronously right before this call, so
			// waiting for it proves the guard is already armed.
			await vi.waitFor(() => expect(api.writeFileText).toHaveBeenCalled());

			// The file watcher's own echo of this exact write reaches the renderer
			// before resolveExternalChangeReview's own write promise resolves —
			// simulated here by firing it out of order, before `finishWrite()`.
			// Without the self-write-echo guard this would misclassify as a fresh
			// external edit and refresh the pending review to the merge's own
			// bytes; with it, the call is a no-op and the state is untouched.
			handleExternalFileChange(path, mergedText);

			expect(viewerStore.get().externalChange).toEqual({
				kind: "review",
				diskContent: externalEditText,
			});

			finishWrite();
			await resolve;

			expect(viewerStore.get().externalChange).toEqual({ kind: "none" });
			expect(viewerStore.get().content).toBe(mergedText);
		});
	});
});

describe("desktop delete while a review is pending (QA4a)", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("completes cleanly, no thrown error, and clears the viewer", async () => {
		const api = createDesktopApi();
		const { appStore, deleteMarkdownFile, viewerStore } =
			await loadStoreActions(api);
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [{ path, modified_at: 1 }],
			},
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: "original",
				diskContent: "original",
				externalChange: { kind: "review", diskContent: "changed outside" },
				status: "ready",
				error: null,
			},
		}));

		await expect(deleteMarkdownFile(path)).resolves.toBeUndefined();

		expect(viewerStore.get().currentPath).toBeNull();
		expect(viewerStore.get().externalChange).toEqual({ kind: "none" });
	});
});

describe("desktop rename/move while a review is pending (Blocker 1)", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	const externalEditText = "original\n\nexternal edit";

	function setPendingReviewDocument(
		appStore: Awaited<ReturnType<typeof loadStoreActions>>["appStore"],
		path: string,
	) {
		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				// While a review is pending, `content`/`diskContent` stay frozen at
				// the pre-external-edit baseline -- the real, most-recent bytes
				// already live on disk as `externalChange.diskContent`.
				content: "original",
				diskContent: "original",
				externalChange: { kind: "review", diskContent: externalEditText },
				status: "ready",
				error: null,
			},
		}));
	}

	it("renameMarkdownFile does not force-save the frozen baseline over the pending external edit", async () => {
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue(externalEditText);
		api.listDirectory.mockResolvedValue({
			files: [{ path: "/workspace/renamed.md", modified_at: 1 }],
			folders: [],
		});
		const { appStore, renameMarkdownFile, viewerStore } =
			await loadStoreActions(api);
		const path = "/workspace/original.md";

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [{ path, modified_at: 1 }],
			},
		}));
		setPendingReviewDocument(appStore, path);

		await renameMarkdownFile(path, "renamed");

		// No save happened at all before the rename -- the pending external
		// edit already on disk was never at risk of being overwritten with the
		// stale pre-edit baseline.
		expect(api.writeFileText).not.toHaveBeenCalled();
		expect(api.renameFile).toHaveBeenCalledWith(path, "/workspace/renamed.md");
		// The rename still proceeds, and the reload after it picks up the real
		// (external-edit) content that was on disk all along.
		expect(viewerStore.get().currentPath).toBe("/workspace/renamed.md");
		expect(viewerStore.get().content).toBe(externalEditText);
	});

	it("moveSidebarItem does not force-save the frozen baseline over the pending external edit", async () => {
		const api = createDesktopApi();
		api.listDirectory.mockResolvedValue({
			files: [{ path: "/workspace/archive/note.md", modified_at: 1 }],
			folders: [],
		});
		const { appStore, moveSidebarItem, viewerStore } =
			await loadStoreActions(api);
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [{ path, modified_at: 1 }],
			},
		}));
		setPendingReviewDocument(appStore, path);

		await moveSidebarItem({ kind: "file", path }, "/workspace/archive");

		expect(api.writeFileText).not.toHaveBeenCalled();
		expect(api.renameFile).toHaveBeenCalledWith(
			path,
			"/workspace/archive/note.md",
		);
		expect(viewerStore.get().currentPath).toBe("/workspace/archive/note.md");
		// The pending review itself is untouched by the move -- not silently
		// cleared or clobbered.
		expect(viewerStore.get().externalChange).toEqual({
			kind: "review",
			diskContent: externalEditText,
		});
	});

	it("moveMarkdownFileToFolder does not force-save the frozen baseline over the pending external edit", async () => {
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue(externalEditText);
		api.listDirectory.mockResolvedValue({
			files: [{ path: "/workspace/archive/note.md", modified_at: 1 }],
			folders: [{ path: "/workspace/archive", modified_at: 1 }],
		});
		const { appStore, moveMarkdownFileToFolder, viewerStore } =
			await loadStoreActions(api);
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [{ path, modified_at: 1 }],
			},
		}));
		setPendingReviewDocument(appStore, path);

		const moved = await moveMarkdownFileToFolder(
			path,
			"/workspace/archive",
			"/workspace",
		);

		expect(moved).toBe(true);
		expect(api.writeFileText).not.toHaveBeenCalled();
		expect(api.renameFile).toHaveBeenCalledWith(
			path,
			"/workspace/archive/note.md",
		);
		expect(viewerStore.get().currentPath).toBe("/workspace/archive/note.md");
		expect(viewerStore.get().content).toBe(externalEditText);
	});
});

describe("desktop sidebar discovery preferences", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("passes the ignored-files preference when refreshing files", async () => {
		const api = createDesktopApi();
		const {
			appStore,
			refreshFiles,
			setShowIgnoredWorkspaceFiles,
			workspaceStore,
		} = await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
			},
		}));

		await refreshFiles();
		expect(api.listDirectory).toHaveBeenLastCalledWith("/workspace", {
			includeIgnoredWorkspaceFiles: false,
		});

		setShowIgnoredWorkspaceFiles(true);
		await Promise.resolve();

		expect(api.listDirectory).toHaveBeenLastCalledWith("/workspace", {
			includeIgnoredWorkspaceFiles: true,
		});
		expect(workspaceStore.get().workspacePath).toBe("/workspace");
	});

	it("does not scan a persisted workspace before startup routing restores it", async () => {
		const api = createDesktopApi();
		const { restorePersistedWorkspace, workspaceStore } =
			await loadStoreActions(api, {
				workspace: {
					workspacePath: "/large-workspace",
					recentWorkspaces: ["/large-workspace"],
					lastOpenedPaths: {},
					sortMode: "recent",
				},
			});

		expect(workspaceStore.get().workspacePath).toBe("/large-workspace");
		expect(api.listDirectory).not.toHaveBeenCalled();

		await restorePersistedWorkspace();

		expect(api.listDirectory).toHaveBeenCalledWith("/large-workspace", {
			includeIgnoredWorkspaceFiles: false,
		});
	});
});

describe("desktop renameMarkdownFile", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("reopens the active file from its renamed path", async () => {
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue("embed content");
		api.listDirectory.mockResolvedValue({
			files: [{ path: "/workspace/renamed.md", modified_at: 1 }],
			folders: [],
		});
		const { appStore, renameMarkdownFile, viewerStore, workspaceStore } =
			await loadStoreActions(api);
		const path = "/workspace/original.md";

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [{ path, modified_at: 1 }],
				lastOpenedPaths: { "/workspace": path },
			},
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: "embed content",
				diskContent: "embed content",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		await renameMarkdownFile(path, "renamed");

		expect(api.renameFile).toHaveBeenCalledWith(path, "/workspace/renamed.md");
		expect(api.readFileText).toHaveBeenLastCalledWith("/workspace/renamed.md");
		expect(viewerStore.get().currentPath).toBe("/workspace/renamed.md");
		expect(viewerStore.get().content).toBe("embed content");
		expect(workspaceStore.get().lastOpenedPaths["/workspace"]).toBe(
			"/workspace/renamed.md",
		);
	});

	it("renames a symlink target without moving the sidebar link", async () => {
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue("target content");
		api.listDirectory.mockResolvedValue({
			files: [
				{
					path: "/workspace/linked.md",
					modified_at: 2,
					is_symlink: true,
					symlink_target: "/outside/target-renamed.md",
					symlink_target_exists: true,
				},
			],
			folders: [],
		});
		const { appStore, renameMarkdownFile, viewerStore, workspaceStore } =
			await loadStoreActions(api);
		const path = "/workspace/linked.md";

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{
						path,
						modified_at: 1,
						is_symlink: true,
						symlink_target: "/outside/target.md",
						symlink_target_exists: true,
					},
				],
				lastOpenedPaths: { "/workspace": path },
			},
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: "target content",
				diskContent: "target content",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		await renameMarkdownFile(path, "target-renamed");

		expect(api.renameSymlinkTarget).toHaveBeenCalledWith(
			path,
			"target-renamed.md",
		);
		expect(api.renameFile).not.toHaveBeenCalled();
		expect(viewerStore.get().currentPath).toBe(path);
		expect(workspaceStore.get().files[0]).toMatchObject({
			path,
			symlink_target: "/outside/target-renamed.md",
		});
	});

	it("updates pinned note paths in workspace config", async () => {
		const api = createDesktopApi();
		const { appStore, renameMarkdownFile, workspaceStore } =
			await loadStoreActions(api);
		const path = "/workspace/original.md";

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [{ path, modified_at: 1 }],
				pinnedNotes: [path],
			},
		}));

		await renameMarkdownFile(path, "renamed");

		expect(workspaceStore.get().pinnedNotes).toEqual(["/workspace/renamed.md"]);
		expect(api.writeWorkspaceConfig).toHaveBeenCalledWith("/workspace", {
			version: 1,
			pinnedNotes: ["renamed.md"],
		});
	});

	it("renames to nested paths relative to the current folder", async () => {
		const api = createDesktopApi();
		api.listDirectory.mockResolvedValue({
			files: [{ path: "/workspace/notes/archive/q1-plan.md", modified_at: 1 }],
			folders: [],
		});
		const { appStore, renameMarkdownFile, viewerStore } =
			await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [{ path: "/workspace/notes/plan.md", modified_at: 1 }],
			},
			document: {
				...current.document,
				currentPath: "/workspace/notes/plan.md",
				lastOpenedPath: "/workspace/notes/plan.md",
				content: "plan",
				diskContent: "plan",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		await renameMarkdownFile("/workspace/notes/plan.md", "archive/q1-plan");

		expect(api.renameFile).toHaveBeenCalledWith(
			"/workspace/notes/plan.md",
			"/workspace/notes/archive/q1-plan.md",
		);
		expect(viewerStore.get().currentPath).toBe(
			"/workspace/notes/archive/q1-plan.md",
		);
	});

	it("renames to nested paths in Windows workspaces", async () => {
		const api = createDesktopApi();
		api.listDirectory.mockResolvedValue({
			files: [
				{ path: "C:/workspace/notes/archive/q1-plan.md", modified_at: 1 },
			],
			folders: [],
		});
		const { appStore, renameMarkdownFile, viewerStore } =
			await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "C:\\workspace",
				files: [{ path: "C:\\workspace\\notes\\plan.md", modified_at: 1 }],
			},
			document: {
				...current.document,
				currentPath: "C:\\workspace\\notes\\plan.md",
				lastOpenedPath: "C:\\workspace\\notes\\plan.md",
				content: "plan",
				diskContent: "plan",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		await renameMarkdownFile(
			"C:\\workspace\\notes\\plan.md",
			"archive/q1-plan",
		);

		expect(api.renameFile).toHaveBeenCalledWith(
			"C:\\workspace\\notes\\plan.md",
			"C:/workspace/notes/archive/q1-plan.md",
		);
		expect(viewerStore.get().currentPath).toBe(
			"C:/workspace/notes/archive/q1-plan.md",
		);
	});

	it("does not rename a missing asset folder", async () => {
		const api = createDesktopApi();
		const { appStore, renameMarkdownFile } = await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [{ path: "/workspace/notes/draft.md", modified_at: 1 }],
			},
		}));

		await renameMarkdownFile("/workspace/notes/draft.md", "archive/draft");

		expect(api.pathExists).toHaveBeenCalledWith(
			"/workspace/notes/draft.assets",
		);
		expect(api.renameFile).toHaveBeenCalledTimes(1);
		expect(api.renameFile).toHaveBeenCalledWith(
			"/workspace/notes/draft.md",
			"/workspace/notes/archive/draft.md",
		);
		expect(api.renameFile).not.toHaveBeenCalledWith(
			"/workspace/notes/draft.assets",
			"/workspace/notes/archive/draft.assets",
		);
	});

	it("rejects rename paths outside the workspace", async () => {
		const api = createDesktopApi();
		const { appStore, renameMarkdownFile } = await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [{ path: "/workspace/original.md", modified_at: 1 }],
			},
		}));

		await renameMarkdownFile("/workspace/original.md", "../outside.md");

		expect(api.renameFile).not.toHaveBeenCalled();
	});

	it("updates backlinks to the renamed file", async () => {
		const api = createDesktopApi();
		api.pathExists.mockResolvedValue(true);
		api.readFileText.mockImplementation(async (path: string) => {
			if (path === "/workspace/notes/source.md") {
				return [
					"[Target](../target.md)",
					'[Titled](../target.md "caption")',
					"![Image](../target.assets/image.png)",
					"[[target.md|Target]]",
				].join("\n");
			}
			return "target";
		});
		const { appStore, renameMarkdownFile } = await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{ path: "/workspace/notes/source.md", modified_at: 1 },
					{ path: "/workspace/target.md", modified_at: 1 },
				],
			},
		}));

		await renameMarkdownFile("/workspace/target.md", "renamed");

		expect(api.writeFileText).toHaveBeenCalledWith(
			"/workspace/notes/source.md",
			[
				"[Target](../renamed.md)",
				'[Titled](../renamed.md "caption")',
				"![Image](../renamed.assets/image.png)",
				"[[renamed.md|Target]]",
			].join("\n"),
		);
	});

	it("renames the associated asset folder and updates refs", async () => {
		const api = createDesktopApi();
		api.pathExists.mockResolvedValue(true);
		api.readFileText.mockImplementation(async (path: string) => {
			if (path === "/workspace/learning.md") {
				return "![Recall](effective-learning-techniques.assets/recall.jpg)";
			}
			return "";
		});
		const { appStore, renameMarkdownFile } = await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{
						path: "/workspace/effective-learning-techniques.md",
						modified_at: 1,
					},
				],
			},
		}));

		await renameMarkdownFile(
			"/workspace/effective-learning-techniques.md",
			"learning",
		);

		expect(api.renameFile).toHaveBeenCalledWith(
			"/workspace/effective-learning-techniques.assets",
			"/workspace/learning.assets",
		);
		expect(api.writeFileText).toHaveBeenCalledWith(
			"/workspace/learning.md",
			"![Recall](learning.assets/recall.jpg)",
		);
	});

	it("preserves unsaved edits when rewriting backlinks in the open file", async () => {
		const api = createDesktopApi();
		api.readFileText.mockImplementation(async (path: string) => {
			if (path === "/workspace/source.md") return "[Target](target.md)";
			return "target";
		});
		const { appStore, renameMarkdownFile, viewerStore } =
			await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{ path: "/workspace/source.md", modified_at: 1 },
					{ path: "/workspace/target.md", modified_at: 1 },
				],
			},
			document: {
				...current.document,
				currentPath: "/workspace/source.md",
				lastOpenedPath: "/workspace/source.md",
				content: "[Target](target.md)\nunsaved edit",
				diskContent: "[Target](target.md)",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		await renameMarkdownFile("/workspace/target.md", "renamed");

		expect(api.writeFileText).toHaveBeenCalledWith(
			"/workspace/source.md",
			"[Target](renamed.md)\nunsaved edit",
		);
		expect(viewerStore.get().content).toBe(
			"[Target](renamed.md)\nunsaved edit",
		);
	});
});

describe("desktop moveSidebarItem", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("moves a file to a folder and updates opened state", async () => {
		const api = createDesktopApi();
		api.listDirectory.mockResolvedValue({
			files: [{ path: "/workspace/archive/note.md", modified_at: 1 }],
			folders: [],
		});
		const { appStore, moveSidebarItem, viewerStore, workspaceStore } =
			await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{ path: "/workspace/note.md", modified_at: 1 },
					{ path: "/workspace/archive/existing.md", modified_at: 1 },
				],
				pinnedNotes: ["/workspace/note.md"],
				lastOpenedPaths: { "/workspace": "/workspace/note.md" },
			},
			document: {
				...current.document,
				currentPath: "/workspace/note.md",
				lastOpenedPath: "/workspace/note.md",
				content: "draft",
				diskContent: "draft",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		await moveSidebarItem(
			{ kind: "file", path: "/workspace/note.md" },
			"/workspace/archive",
		);

		expect(api.renameFile).toHaveBeenCalledWith(
			"/workspace/note.md",
			"/workspace/archive/note.md",
		);
		expect(viewerStore.get().currentPath).toBe("/workspace/archive/note.md");
		expect(workspaceStore.get().pinnedNotes).toEqual([
			"/workspace/archive/note.md",
		]);
		expect(api.writeWorkspaceConfig).toHaveBeenCalledWith("/workspace", {
			version: 1,
			pinnedNotes: ["archive/note.md"],
		});
	});

	it("moves a symlink file without rewriting target content", async () => {
		const api = createDesktopApi();
		api.pathExists.mockResolvedValue(true);
		api.listDirectory.mockResolvedValue({
			files: [
				{
					path: "/workspace/archive/linked.md",
					modified_at: 2,
					is_symlink: true,
					symlink_target: "/outside/target.md",
					symlink_target_exists: true,
				},
			],
			folders: [],
		});
		const { appStore, moveSidebarItem, workspaceStore } =
			await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{
						path: "/workspace/linked.md",
						modified_at: 1,
						is_symlink: true,
						symlink_target: "/outside/target.md",
						symlink_target_exists: true,
					},
				],
				folders: [{ path: "/workspace/archive", modified_at: 1 }],
			},
		}));

		await moveSidebarItem(
			{ kind: "file", path: "/workspace/linked.md" },
			"/workspace/archive",
		);

		expect(api.renameFile).toHaveBeenCalledWith(
			"/workspace/linked.md",
			"/workspace/archive/linked.md",
		);
		expect(api.readFileText).not.toHaveBeenCalled();
		expect(api.writeFileText).not.toHaveBeenCalled();
		expect(api.renameFile).not.toHaveBeenCalledWith(
			"/workspace/linked.assets",
			"/workspace/archive/linked.assets",
		);
		expect(workspaceStore.get().files[0]).toMatchObject({
			path: "/workspace/archive/linked.md",
			is_symlink: true,
		});
	});

	it("updates relative refs when moving a file", async () => {
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue(
			[
				"![Recall](effective-learning-techniques.assets/recall-diagram.jpg)",
				'<iframe src="./file-index.html"></iframe>',
				"[External](https://example.com)",
			].join("\n"),
		);
		const { appStore, moveSidebarItem } = await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{ path: "/workspace/samples/source.md", modified_at: 1 },
					{
						path: "/workspace/deeply/nested/folder/example.md",
						modified_at: 1,
					},
				],
			},
		}));

		await moveSidebarItem(
			{ kind: "file", path: "/workspace/samples/source.md" },
			"/workspace/deeply/nested/folder",
		);

		expect(api.writeFileText).toHaveBeenCalledWith(
			"/workspace/deeply/nested/folder/source.md",
			[
				"![Recall](../../../samples/effective-learning-techniques.assets/recall-diagram.jpg)",
				'<iframe src="../../../samples/file-index.html"></iframe>',
				"[External](https://example.com)",
			].join("\n"),
		);
	});

	it("moves the associated asset folder with a moved file", async () => {
		const api = createDesktopApi();
		api.pathExists.mockResolvedValue(true);
		api.readFileText.mockResolvedValue(
			"![Recall](source.assets/recall-diagram.jpg)",
		);
		const { appStore, moveSidebarItem } = await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{ path: "/workspace/samples/source.md", modified_at: 1 },
					{
						path: "/workspace/deeply/nested/folder/example.md",
						modified_at: 1,
					},
				],
			},
		}));

		await moveSidebarItem(
			{ kind: "file", path: "/workspace/samples/source.md" },
			"/workspace/deeply/nested/folder",
		);

		expect(api.renameFile).toHaveBeenCalledWith(
			"/workspace/samples/source.assets",
			"/workspace/deeply/nested/folder/source.assets",
		);
		expect(api.writeFileText).not.toHaveBeenCalled();
	});

	it("suffixes folder conflicts and rewrites descendants", async () => {
		const api = createDesktopApi();
		api.readFileText.mockImplementation(async (path: string) => {
			if (path === "/workspace/archive/client 1/brief.md") {
				return "[Outside](../outside.md)";
			}
			return "outside";
		});
		const { appStore, moveSidebarItem, viewerStore } =
			await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{ path: "/workspace/archive/client/existing.md", modified_at: 1 },
					{ path: "/workspace/client/brief.md", modified_at: 1 },
					{ path: "/workspace/outside.md", modified_at: 1 },
				],
			},
			document: {
				...current.document,
				currentPath: "/workspace/client/brief.md",
				lastOpenedPath: "/workspace/client/brief.md",
				content: "[Outside](../outside.md)",
				diskContent: "[Outside](../outside.md)",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		await moveSidebarItem(
			{ kind: "folder", folderId: "client/" },
			"/workspace/archive",
		);

		expect(api.renameFile).toHaveBeenCalledWith(
			"/workspace/client",
			"/workspace/archive/client 1",
		);
		expect(viewerStore.get().currentPath).toBe(
			"/workspace/archive/client 1/brief.md",
		);
		expect(api.writeFileText).toHaveBeenCalledWith(
			"/workspace/archive/client 1/brief.md",
			"[Outside](../../outside.md)",
		);
	});

	it("rewrites folder descendant refs and external backlinks", async () => {
		const api = createDesktopApi();
		api.readFileText.mockImplementation(async (path: string) => {
			if (path === "/workspace/archive/project/notes/a.md") {
				return [
					"[Outside](../../outside.md)",
					"[Peer](b.md)",
					'<img src="../../shared/image.png">',
				].join("\n");
			}
			if (path === "/workspace/archive/project/notes/b.md") {
				return "[Outside](../../outside.md)";
			}
			if (path === "/workspace/outside.md") {
				return ["[A](project/notes/a.md)", "[[project/notes/b.md|B]]"].join(
					"\n",
				);
			}
			return "";
		});
		const { appStore, moveSidebarItem } = await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{ path: "/workspace/project/notes/a.md", modified_at: 1 },
					{ path: "/workspace/project/notes/b.md", modified_at: 1 },
					{ path: "/workspace/outside.md", modified_at: 1 },
				],
			},
		}));

		await moveSidebarItem(
			{ kind: "folder", folderId: "project/" },
			"/workspace/archive",
		);

		expect(api.writeFileText).toHaveBeenCalledWith(
			"/workspace/archive/project/notes/a.md",
			[
				"[Outside](../../../outside.md)",
				"[Peer](b.md)",
				'<img src="../../../shared/image.png">',
			].join("\n"),
		);
		expect(api.writeFileText).toHaveBeenCalledWith(
			"/workspace/archive/project/notes/b.md",
			"[Outside](../../../outside.md)",
		);
		expect(api.writeFileText).toHaveBeenCalledWith(
			"/workspace/outside.md",
			[
				"[A](archive/project/notes/a.md)",
				"[[archive/project/notes/b.md|B]]",
			].join("\n"),
		);
	});
});

describe("desktop moveMarkdownFileToFolder", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("moves a file with its existing name and updates pinned state", async () => {
		const api = createDesktopApi();
		api.listDirectory.mockResolvedValue({
			files: [{ path: "/workspace/archive/note.md", modified_at: 1 }],
			folders: [{ path: "/workspace/archive", modified_at: 1 }],
		});
		const { appStore, moveMarkdownFileToFolder, workspaceStore } =
			await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{ path: "/workspace/note.md", modified_at: 1 },
					{ path: "/workspace/archive/existing.md", modified_at: 1 },
				],
				pinnedNotes: ["/workspace/note.md"],
			},
		}));

		await moveMarkdownFileToFolder(
			"/workspace/note.md",
			"/workspace/archive",
			"/workspace",
		);

		expect(api.renameFile).toHaveBeenCalledWith(
			"/workspace/note.md",
			"/workspace/archive/note.md",
		);
		expect(workspaceStore.get().pinnedNotes).toEqual([
			"/workspace/archive/note.md",
		]);
	});

	it("blocks target filename conflicts instead of suffixing", async () => {
		const api = createDesktopApi();
		const { appStore, moveMarkdownFileToFolder } = await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{ path: "/workspace/note.md", modified_at: 1 },
					{ path: "/workspace/archive/note.md", modified_at: 1 },
				],
			},
		}));

		const moved = await moveMarkdownFileToFolder(
			"/workspace/note.md",
			"/workspace/archive",
			"/workspace",
		);

		expect(moved).toBe(false);
		expect(api.renameFile).not.toHaveBeenCalled();
	});

	it("moves the current file to another workspace and opens it there", async () => {
		const api = createDesktopApi();
		api.listDirectory.mockImplementation(async (path: string) => {
			if (path === "/target-workspace") {
				return {
					files: [{ path: "/target-workspace/note.md", modified_at: 2 }],
					folders: [],
				};
			}
			return { files: [], folders: [] };
		});
		api.readFileText.mockImplementation(async (path: string) =>
			path === "/target-workspace/note.md" ? "draft" : "before",
		);
		const { appStore, moveMarkdownFileToFolder, viewerStore, workspaceStore } =
			await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/source-workspace",
				files: [{ path: "/source-workspace/note.md", modified_at: 1 }],
				pinnedNotes: ["/source-workspace/note.md"],
				lastOpenedPaths: {
					"/source-workspace": "/source-workspace/note.md",
				},
			},
			document: {
				...current.document,
				currentPath: "/source-workspace/note.md",
				lastOpenedPath: "/source-workspace/note.md",
				content: "draft",
				diskContent: "draft",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		const moved = await moveMarkdownFileToFolder(
			"/source-workspace/note.md",
			"/target-workspace",
			"/target-workspace",
		);

		expect(moved).toBe(true);
		expect(api.renameFile).toHaveBeenCalledWith(
			"/source-workspace/note.md",
			"/target-workspace/note.md",
		);
		expect(api.writeWorkspaceConfig).toHaveBeenCalledWith("/source-workspace", {
			version: 1,
			pinnedNotes: [],
		});
		expect(workspaceStore.get().workspacePath).toBe("/target-workspace");
		expect(viewerStore.get().currentPath).toBe("/target-workspace/note.md");
		expect(viewerStore.get().content).toBe("draft");
	});
});

describe("desktop loadPath", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("records a history revision for the outgoing file's unsaved edit on a workspace/file switch (R17)", async () => {
		// EditorView's own unmount-cleanup forced cut always no-ops for this
		// switch (savePathContent's currentPath guard has already flipped to the
		// new path by the time it runs) — loadPath's own proactive outgoing-file
		// save is the only place this edit can be tagged with history, since it
		// runs before currentPath moves.
		const api = createDesktopApi();
		const outgoingPath = "/workspace/a.md";
		const nextPath = "/workspace/b.md";
		api.readFileText.mockImplementation(async (path: string) =>
			path === nextPath ? "b content" : "before",
		);
		const { appStore, loadPath, viewerStore } = await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{ path: outgoingPath, modified_at: 1 },
					{ path: nextPath, modified_at: 1 },
				],
			},
			document: {
				...current.document,
				currentPath: outgoingPath,
				lastOpenedPath: outgoingPath,
				content: "unsaved edit on a.md",
				diskContent: "before",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		await loadPath(nextPath);

		expect(api.writeFileText).toHaveBeenCalledWith(
			outgoingPath,
			"unsaved edit on a.md",
			{ historyCause: "idle-session" },
		);
		expect(viewerStore.get().currentPath).toBe(nextPath);
		expect(viewerStore.get().content).toBe("b content");
	});

	it("refreshes the sidebar when a selected file no longer exists", async () => {
		const api = createDesktopApi();
		const missingPath = "/workspace/missing.md";
		const remainingPath = "/workspace/remaining.md";
		api.readFileText.mockRejectedValue(
			new Error(`ENOENT: no such file or directory, open '${missingPath}'`),
		);
		api.listDirectory.mockResolvedValue({
			files: [{ path: remainingPath, modified_at: 2 }],
			folders: [],
		});
		const { appStore, loadPath, workspaceStore } = await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [
					{ path: missingPath, modified_at: 1 },
					{ path: remainingPath, modified_at: 2 },
				],
			},
		}));

		await loadPath(missingPath);

		await vi.waitFor(() => {
			expect(workspaceStore.get().files).toEqual([
				{ path: remainingPath, modified_at: 2 },
			]);
		});
	});

	it("debounces repeated missing-file sidebar refreshes", async () => {
		vi.useFakeTimers();
		try {
			const api = createDesktopApi();
			api.readFileText.mockRejectedValue(
				new Error("ENOENT: no such file or directory"),
			);
			api.listDirectory.mockResolvedValue({ files: [], folders: [] });
			const { appStore, loadPath } = await loadStoreActions(api);

			appStore.set((current) => ({
				...current,
				workspace: {
					...current.workspace,
					workspacePath: "/workspace",
					files: [
						{ path: "/workspace/a.md", modified_at: 1 },
						{ path: "/workspace/b.md", modified_at: 1 },
					],
				},
			}));

			await loadPath("/workspace/a.md");
			await loadPath("/workspace/b.md");

			expect(api.listDirectory).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(250);

			expect(api.listDirectory).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("desktop workspace switching", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns false and leaves workspace unchanged when the folder picker is canceled", async () => {
		const api = createDesktopApi();
		api.openFolderPicker.mockResolvedValue(undefined);
		const { openWorkspace, workspaceStore } = await loadStoreActions(api);

		const opened = await openWorkspace();

		expect(opened).toBe(false);
		expect(api.openFolderPicker).toHaveBeenCalledOnce();
		expect(api.listDirectory).not.toHaveBeenCalled();
		expect(api.readWorkspaceConfig).not.toHaveBeenCalled();
		expect(workspaceStore.get().workspacePath).toBe(null);
	});

	it("returns true after opening a picked workspace", async () => {
		const api = createDesktopApi();
		api.openFolderPicker.mockResolvedValue("/workspace");
		const { openWorkspace, workspaceStore } = await loadStoreActions(api);

		const opened = await openWorkspace();

		expect(opened).toBe(true);
		expect(workspaceStore.get().workspacePath).toBe("/workspace");
		expect(workspaceStore.get().recentWorkspaces[0]).toBe("/workspace");
	});

	it("still reports the workspace as opened (with an empty file list) when listing fails", async () => {
		// A workspace switch (e.g. clicking a recent workspace) can fail server-side
		// for reasons like a revoked grant. It must surface an error, not silently
		// pretend the folder is empty with no explanation.
		const api = createDesktopApi();
		api.listDirectory.mockRejectedValue(
			new Error("Path is outside granted scope"),
		);
		const { openWorkspace, workspaceStore } = await loadStoreActions(api);

		const opened = await openWorkspace("/workspace");

		expect(opened).toBe(true);
		expect(workspaceStore.get().workspacePath).toBe("/workspace");
		expect(workspaceStore.get().files).toEqual([]);
	});
});

describe("desktop pinned notes", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("loads missing workspace config as an empty pin set", async () => {
		const api = createDesktopApi();
		api.readWorkspaceConfig.mockResolvedValue({ version: 1, pinnedNotes: [] });
		const { openWorkspace, workspaceStore } = await loadStoreActions(api);

		await openWorkspace("/workspace");

		expect(api.readWorkspaceConfig).toHaveBeenCalledWith("/workspace");
		expect(workspaceStore.get().pinnedNotes).toEqual([]);
	});

	it("loads persisted pins as absolute workspace paths", async () => {
		const api = createDesktopApi();
		api.readWorkspaceConfig.mockResolvedValue({
			version: 1,
			pinnedNotes: ["notes/a.md"],
		});
		const { openWorkspace, workspaceStore } = await loadStoreActions(api);

		await openWorkspace("/workspace");

		expect(workspaceStore.get().pinnedNotes).toEqual(["/workspace/notes/a.md"]);
	});

	it("pins and unpins notes through workspace config", async () => {
		const api = createDesktopApi();
		const { appStore, togglePinnedNote, workspaceStore } =
			await loadStoreActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [{ path: "/workspace/note.md", modified_at: 1 }],
			},
		}));

		await togglePinnedNote("/workspace/note.md");
		expect(workspaceStore.get().pinnedNotes).toEqual(["/workspace/note.md"]);
		expect(api.writeWorkspaceConfig).toHaveBeenLastCalledWith("/workspace", {
			version: 1,
			pinnedNotes: ["note.md"],
		});

		await togglePinnedNote("/workspace/note.md");
		expect(workspaceStore.get().pinnedNotes).toEqual([]);
		expect(api.writeWorkspaceConfig).toHaveBeenLastCalledWith("/workspace", {
			version: 1,
			pinnedNotes: [],
		});
	});
});
