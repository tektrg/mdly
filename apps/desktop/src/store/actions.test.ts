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
			setShowGitStatusIndicators,
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
			includeGitStatus: false,
		});

		setShowIgnoredWorkspaceFiles(true);
		await Promise.resolve();

		expect(api.listDirectory).toHaveBeenLastCalledWith("/workspace", {
			includeIgnoredWorkspaceFiles: true,
			includeGitStatus: false,
		});

		setShowGitStatusIndicators(true);
		await Promise.resolve();

		expect(api.listDirectory).toHaveBeenLastCalledWith("/workspace", {
			includeIgnoredWorkspaceFiles: true,
			includeGitStatus: true,
		});
		expect(workspaceStore.get().workspacePath).toBe("/workspace");
	});

	it("does not scan a persisted workspace before startup routing restores it", async () => {
		const api = createDesktopApi();
		const { restorePersistedWorkspace, workspaceStore } = await loadStoreActions(
			api,
			{
				workspace: {
					workspacePath: "/large-workspace",
					recentWorkspaces: ["/large-workspace"],
					lastOpenedPaths: {},
					sortMode: "recent",
				},
			},
		);

		expect(workspaceStore.get().workspacePath).toBe("/large-workspace");
		expect(api.listDirectory).not.toHaveBeenCalled();

		await restorePersistedWorkspace();

		expect(api.listDirectory).toHaveBeenCalledWith("/large-workspace", {
			includeIgnoredWorkspaceFiles: false,
			includeGitStatus: false,
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
