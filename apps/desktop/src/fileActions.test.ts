import { beforeEach, describe, expect, it, vi } from "vitest";

function createDesktopApi() {
	return {
		readFileText: vi.fn(async (_path: string) => ""),
		writeFileText: vi.fn(async (_path: string, _content: string) => {}),
		listDirectory: vi.fn(async () => ({
			files: [] as { path: string; modified_at: number }[],
			folders: [] as { path: string; modified_at: number }[],
		})),
		getNotionPageMarkdown: vi.fn(async () => ({
			pageId: "page-id",
			account: "7lab",
			markdown: "# Remote",
			contentHash: "remote-hash",
		})),
		queryNotionDatabase: vi.fn(),
		updateNotionPageMarkdown: vi.fn(async () => ({
			pageId: "page-id",
			account: "7lab",
			contentHash: "pushed-hash",
		})),
	};
}

async function loadFileActions(api: ReturnType<typeof createDesktopApi>) {
	vi.resetModules();
	vi.stubGlobal("localStorage", {
		getItem: vi.fn(() => null),
		setItem: vi.fn(),
	});
	vi.stubGlobal("window", {
		desktopApi: api,
		setTimeout,
		clearTimeout,
	});

	const actions = await import("./fileActions");
	const state = await import("./store/state");
	return { ...actions, ...state };
}

function linkedPageMarkdown({
	account = "7lab",
	contentHash = "base-hash",
	body = "# Existing roadmap",
}: {
	account?: string;
	contentHash?: string;
	body?: string;
} = {}) {
	return [
		"---",
		"Status: Draft",
		"notion:",
		'  object: "page"',
		'  page_id: "page-id"',
		`  account: "${account}"`,
		'  url: "https://notion.so/page-id"',
		'  title: "Roadmap"',
		'  last_edited_time: "2026-06-25T00:00:00.000Z"',
		`  content_hash: "${contentHash}"`,
		'  sync: "linked"',
		"---",
		body,
	].join("\n");
}

function setOpenFile(
	appStore: Awaited<ReturnType<typeof loadFileActions>>["appStore"],
	path: string,
	content: string,
) {
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
			content,
			diskContent: content,
			externalChange: { kind: "none" },
			status: "ready",
			error: null,
		},
	}));
}

function bindFileContent(
	api: ReturnType<typeof createDesktopApi>,
	initialContent: string,
) {
	let fileContent = initialContent;
	api.readFileText.mockImplementation(async () => fileContent);
	api.writeFileText.mockImplementation(async (_path, content) => {
		fileContent = content;
	});
	return () => fileContent;
}

describe("Notion file actions", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("opens an existing linked Notion page instead of importing a duplicate", async () => {
		const api = createDesktopApi();
		const existingPath = "/workspace/roadmap.md";
		const linkedMarkdown = linkedPageMarkdown();
		api.readFileText.mockResolvedValue(linkedMarkdown);
		const { appStore, openOrImportNotionPage, viewerStore } =
			await loadFileActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [{ path: existingPath, modified_at: 1 }],
			},
		}));

		const openedPath = await openOrImportNotionPage({
			id: "page-id",
			object: "page",
			account: "7lab",
			title: "Roadmap",
			url: "https://notion.so/page-id",
			lastEditedTime: "2026-06-25T00:00:00.000Z",
		});

		expect(openedPath).toBe(existingPath);
		expect(viewerStore.get().currentPath).toBe(existingPath);
		expect(viewerStore.get().content).toBe(linkedMarkdown);
		expect(api.getNotionPageMarkdown).not.toHaveBeenCalled();
		expect(api.writeFileText).not.toHaveBeenCalled();
	});

	it("blocks a normal push when Notion changed since the last sync", async () => {
		const api = createDesktopApi();
		api.getNotionPageMarkdown.mockResolvedValue({
			pageId: "page-id",
			account: "7lab",
			markdown: "# Remote changed",
			contentHash: "remote-changed-hash",
		});
		const { appStore, pushCurrentNotionPage } = await loadFileActions(api);
		const path = "/workspace/roadmap.md";
		const localMarkdown = linkedPageMarkdown({ contentHash: "base-hash" });
		setOpenFile(appStore, path, localMarkdown);

		const result = await pushCurrentNotionPage();

		expect(result).toEqual({ kind: "remote-changed" });
		expect(api.getNotionPageMarkdown).toHaveBeenCalledWith("page-id", "7lab");
		expect(api.updateNotionPageMarkdown).not.toHaveBeenCalled();
	});

	it("uses the stored account and refreshes metadata after a forced push", async () => {
		const api = createDesktopApi();
		api.updateNotionPageMarkdown.mockResolvedValue({
			pageId: "page-id",
			account: "aptusfit",
			contentHash: "pushed-hash",
		});
		const { appStore, pushCurrentNotionPage, viewerStore } =
			await loadFileActions(api);
		const path = "/workspace/roadmap.md";
		const localMarkdown = linkedPageMarkdown({
			account: "aptusfit",
			contentHash: "old-hash",
			body: "# Local edit",
		});
		setOpenFile(appStore, path, localMarkdown);
		const getFileContent = bindFileContent(api, localMarkdown);

		const result = await pushCurrentNotionPage({
			forceRemoteOverwrite: true,
		});

		expect(result).toEqual({ kind: "pushed" });
		expect(api.getNotionPageMarkdown).not.toHaveBeenCalled();
		expect(api.updateNotionPageMarkdown).toHaveBeenCalledWith(
			"page-id",
			"---\nStatus: Draft\n---\n# Local edit",
			"aptusfit",
		);
		expect(getFileContent()).toContain('account: "aptusfit"');
		expect(getFileContent()).toContain('content_hash: "pushed-hash"');
		expect(viewerStore.get().content).toBe(getFileContent());
	});

	it("refuses refresh over local edits unless forced, then uses the stored account", async () => {
		const api = createDesktopApi();
		api.getNotionPageMarkdown.mockResolvedValue({
			pageId: "page-id",
			account: "aptusfit",
			markdown: "---\nStatus: Remote\n---\n# Remote",
			contentHash: "remote-hash",
		});
		const { appStore, refreshCurrentNotionPage, viewerStore } =
			await loadFileActions(api);
		const path = "/workspace/roadmap.md";
		const localMarkdown = linkedPageMarkdown({
			account: "aptusfit",
			contentHash: "old-hash",
			body: "# Unsynced local edit",
		});
		setOpenFile(appStore, path, localMarkdown);
		const getFileContent = bindFileContent(api, localMarkdown);
		api.listDirectory.mockResolvedValue({
			files: [{ path, modified_at: 2 }],
			folders: [],
		});

		await expect(refreshCurrentNotionPage()).resolves.toBe(false);
		expect(api.getNotionPageMarkdown).not.toHaveBeenCalled();

		await expect(
			refreshCurrentNotionPage({ forceLocalOverwrite: true }),
		).resolves.toBe(true);
		expect(api.getNotionPageMarkdown).toHaveBeenCalledWith(
			"page-id",
			"aptusfit",
		);
		expect(getFileContent()).toContain("# Remote");
		expect(getFileContent()).toContain('account: "aptusfit"');
		expect(getFileContent()).toContain('content_hash: "remote-hash"');
		expect(viewerStore.get().content).toBe(getFileContent());
	});
});
