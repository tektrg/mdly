import {
	combineMarkdownFrontMatter,
	markdownToTiptapDoc,
	parseMarkdownFrontMatter,
	tiptapDocToMarkdown,
} from "@hubble.md/editor";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notionMarkdownContentHash } from "./notion/contentHash";

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
		openExternalUrl: vi.fn(async (_url: string) => {}),
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
	pageId = "page-id",
	url = "https://notion.so/page-id",
}: {
	account?: string;
	contentHash?: string;
	body?: string;
	pageId?: string;
	url?: string;
} = {}) {
	return [
		"---",
		"Status: Draft",
		"notion:",
		'  object: "page"',
		`  page_id: "${pageId}"`,
		`  account: "${account}"`,
		`  url: "${url}"`,
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

function editorSerializedMarkdown(markdown: string): string {
	const parsed = parseMarkdownFrontMatter(markdown);
	const body = tiptapDocToMarkdown(markdownToTiptapDoc(parsed.body));
	return parsed.type === "none"
		? body
		: combineMarkdownFrontMatter(parsed.raw, body);
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

	it("opens an existing linked Notion mention page using the current page account", async () => {
		const api = createDesktopApi();
		const pageId = "f90eb74d673647d8b034ac9919ea3ff5";
		const existingPath = "/workspace/roadmap.md";
		const linkedMarkdown = linkedPageMarkdown({
			account: "aptusfit",
			pageId,
			url: `https://app.notion.com/p/${pageId}`,
		});
		api.readFileText.mockResolvedValue(linkedMarkdown);
		const { appStore, openOrImportNotionMentionPage, viewerStore } =
			await loadFileActions(api);

		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [{ path: existingPath, modified_at: 1 }],
			},
		}));

		const matchedPath = await openOrImportNotionMentionPage(
			`https://app.notion.com/p/${pageId}`,
			{ account: "aptusfit" },
		);

		expect(matchedPath).toBe(existingPath);
		expect(viewerStore.get().currentPath).toBe(existingPath);
		expect(api.getNotionPageMarkdown).not.toHaveBeenCalled();
		expect(api.openExternalUrl).not.toHaveBeenCalled();
	});

	it("imports a Notion mention page with the supplied account", async () => {
		const api = createDesktopApi();
		const { appStore, openOrImportNotionMentionPage } =
			await loadFileActions(api);
		appStore.set((current) => ({
			...current,
			workspace: {
				...current.workspace,
				workspacePath: "/workspace",
				files: [],
				folders: [{ path: "/workspace/Notes", modified_at: 1 }],
			},
		}));

		const openedPath = await openOrImportNotionMentionPage(
			"https://app.notion.com/p/f90eb74d673647d8b034ac9919ea3ff5",
			{ account: "aptusfit", folderPath: "/workspace/Notes" },
		);

		expect(openedPath).toBe("/workspace/Notes/Notion page f90eb74d.md");
		expect(api.getNotionPageMarkdown).toHaveBeenCalledWith(
			"f90eb74d673647d8b034ac9919ea3ff5",
			"aptusfit",
		);
		expect(api.writeFileText).toHaveBeenCalledWith(
			"/workspace/Notes/Notion page f90eb74d.md",
			expect.stringContaining('account: "aptusfit"'),
		);
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
		const remoteMarkdown = "---\nStatus: Draft\n---\n# Local edit";
		const remoteHash = notionMarkdownContentHash(remoteMarkdown);
		api.getNotionPageMarkdown.mockResolvedValue({
			pageId: "page-id",
			account: "aptusfit",
			markdown: remoteMarkdown,
			contentHash: remoteHash,
		});
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
		expect(api.updateNotionPageMarkdown).toHaveBeenCalledWith(
			"page-id",
			"# Local edit",
			"aptusfit",
			{
				currentMarkdown: "# Local edit",
				previousMarkdown: "# Local edit",
			},
		);
		expect(api.getNotionPageMarkdown).toHaveBeenCalledWith(
			"page-id",
			"aptusfit",
		);
		expect(getFileContent()).toContain('account: "aptusfit"');
		expect(getFileContent()).toContain(`content_hash: "${remoteHash}"`);
		expect(getFileContent()).toContain("Status: Draft");
		expect(viewerStore.get().content).toBe(getFileContent());
	});

	it("passes previous and current remote markdown so Notion image URLs can be preserved", async () => {
		const api = createDesktopApi();
		const oldSignedUrl =
			"https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/image.png?X-Amz-Signature=old";
		const currentSignedUrl =
			"https://prod-files-secure.s3.us-west-2.amazonaws.com/workspace/image.png?X-Amz-Signature=current";
		const oldRemoteMarkdown = `---\nStatus: Draft\n---\n![diagram](${oldSignedUrl})\n\nOld copy`;
		const currentRemoteMarkdown = `---\nStatus: Draft\n---\n![diagram](${currentSignedUrl})\n\nOld copy`;
		const pushedRemoteMarkdown = `---\nStatus: Draft\n---\n![diagram](${currentSignedUrl})\n\nNew copy`;
		api.getNotionPageMarkdown
			.mockResolvedValueOnce({
				pageId: "page-id",
				account: "7lab",
				markdown: currentRemoteMarkdown,
				contentHash: notionMarkdownContentHash(currentRemoteMarkdown),
			})
			.mockResolvedValueOnce({
				pageId: "page-id",
				account: "7lab",
				markdown: pushedRemoteMarkdown,
				contentHash: notionMarkdownContentHash(pushedRemoteMarkdown),
			});
		const { appStore, pushCurrentNotionPage } = await loadFileActions(api);
		const path = "/workspace/roadmap.md";
		const baselineMarkdown = linkedPageMarkdown({
			contentHash: notionMarkdownContentHash(oldRemoteMarkdown),
			body: `![diagram](${oldSignedUrl})\n\nOld copy`,
		});
		const editedMarkdown = linkedPageMarkdown({
			contentHash: notionMarkdownContentHash(oldRemoteMarkdown),
			body: `![diagram](${oldSignedUrl})\n\nNew copy`,
		});
		setOpenFile(appStore, path, baselineMarkdown);
		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				content: editedMarkdown,
			},
		}));
		bindFileContent(api, baselineMarkdown);

		await expect(pushCurrentNotionPage()).resolves.toEqual({ kind: "pushed" });

		expect(api.updateNotionPageMarkdown).toHaveBeenCalledWith(
			"page-id",
			`![diagram](${oldSignedUrl})\n\nNew copy`,
			"7lab",
			{
				previousMarkdown: `![diagram](${oldSignedUrl})\n\nOld copy`,
				currentMarkdown: `![diagram](${currentSignedUrl})\n\nOld copy`,
			},
		);
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

		await expect(refreshCurrentNotionPage()).resolves.toEqual({
			kind: "local-changes",
		});
		expect(api.getNotionPageMarkdown).toHaveBeenCalledWith(
			"page-id",
			"aptusfit",
		);
		expect(api.writeFileText).not.toHaveBeenCalled();

		await expect(
			refreshCurrentNotionPage({ forceLocalOverwrite: true }),
		).resolves.toEqual({ kind: "refreshed" });
		expect(api.getNotionPageMarkdown).toHaveBeenCalledWith(
			"page-id",
			"aptusfit",
		);
		expect(getFileContent()).toContain("# Remote");
		expect(getFileContent()).toContain('account: "aptusfit"');
		expect(getFileContent()).toContain('content_hash: "remote-hash"');
		expect(viewerStore.get().content).toBe(getFileContent());
	});

	it("skips writing when refresh content is already current", async () => {
		const api = createDesktopApi();
		const remoteMarkdown = "---\nStatus: Draft\n---\n# Existing roadmap";
		const remoteHash = notionMarkdownContentHash(remoteMarkdown);
		api.getNotionPageMarkdown.mockResolvedValue({
			pageId: "page-id",
			account: "7lab",
			markdown: remoteMarkdown,
			contentHash: remoteHash,
		});
		const { appStore, refreshCurrentNotionPage, viewerStore } =
			await loadFileActions(api);
		const path = "/workspace/roadmap.md";
		const localMarkdown = linkedPageMarkdown({
			contentHash: remoteHash,
			body: "# Existing roadmap",
		});
		setOpenFile(appStore, path, localMarkdown);
		bindFileContent(api, localMarkdown);
		api.listDirectory.mockResolvedValue({
			files: [{ path, modified_at: 2 }],
			folders: [],
		});

		await expect(refreshCurrentNotionPage()).resolves.toEqual({
			kind: "refreshed",
		});

		expect(api.writeFileText).not.toHaveBeenCalled();
		expect(api.readFileText).not.toHaveBeenCalled();
		expect(api.listDirectory).not.toHaveBeenCalled();
		expect(viewerStore.get().content).toBe(localMarkdown);
	});

	it("repairs legacy content hashes when local content still matches Notion", async () => {
		const api = createDesktopApi();
		const remoteMarkdown = "---\nStatus: Draft\n---\n\n# Existing roadmap";
		api.getNotionPageMarkdown.mockResolvedValue({
			pageId: "page-id",
			account: "7lab",
			markdown: remoteMarkdown,
			contentHash: notionMarkdownContentHash(remoteMarkdown),
		});
		const { appStore, refreshCurrentNotionPage, viewerStore } =
			await loadFileActions(api);
		const path = "/workspace/roadmap.md";
		const localMarkdown = linkedPageMarkdown({
			contentHash: "legacy-raw-hash",
			body: "# Existing roadmap",
		});
		setOpenFile(appStore, path, localMarkdown);
		const getFileContent = bindFileContent(api, localMarkdown);
		api.listDirectory.mockResolvedValue({
			files: [{ path, modified_at: 2 }],
			folders: [],
		});

		await expect(refreshCurrentNotionPage()).resolves.toEqual({
			kind: "refreshed",
		});

		expect(api.writeFileText).toHaveBeenCalled();
		expect(getFileContent()).toContain("# Existing roadmap");
		expect(getFileContent()).toContain(
			`content_hash: "${notionMarkdownContentHash(remoteMarkdown)}"`,
		);
		expect(viewerStore.get().content).toBe(getFileContent());
	});

	it("refreshes when open editor content only differs by Hubble serialization", async () => {
		const api = createDesktopApi();
		const remoteMarkdown = [
			"---",
			"Status: Draft",
			"---",
			'<callout icon="/icons/checklist_blue.svg">',
			"\t**MVP focus**",
			"\tIndented detail",
			"</callout>",
			"## Scope",
			"### Details",
			"- Parent item",
			"  - Nested item",
			"    - Deeper item",
		].join("\n");
		api.getNotionPageMarkdown.mockResolvedValue({
			pageId: "page-id",
			account: "7lab",
			markdown: remoteMarkdown,
			contentHash: notionMarkdownContentHash(remoteMarkdown),
		});
		const { appStore, refreshCurrentNotionPage } = await loadFileActions(api);
		const path = "/workspace/roadmap.md";
		const baselineMarkdown = linkedPageMarkdown({
			contentHash: "legacy-editor-hash",
			body: remoteMarkdown.replace("---\nStatus: Draft\n---\n", ""),
		});
		const editorMarkdown = linkedPageMarkdown({
			contentHash: "legacy-editor-hash",
			body: editorSerializedMarkdown(
				baselineMarkdown.replace(/^---[\s\S]*?---\n/, ""),
			),
		});
		setOpenFile(appStore, path, baselineMarkdown);
		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				content: editorMarkdown,
			},
		}));
		bindFileContent(api, baselineMarkdown);
		api.listDirectory.mockResolvedValue({
			files: [{ path, modified_at: 2 }],
			folders: [],
		});

		await expect(refreshCurrentNotionPage()).resolves.toEqual({
			kind: "refreshed",
		});

		expect(api.writeFileText).toHaveBeenCalled();
	});

	it("refreshes when autosaved disk content only differs by Hubble serialization", async () => {
		const api = createDesktopApi();
		const remoteMarkdown = [
			"---",
			"Status: Draft",
			"---",
			'<callout icon="/icons/checklist_blue.svg">',
			"\t**MVP focus**",
			"\tIndented detail",
			"</callout>",
			"## Scope",
			"### Details",
			"- Parent item",
			"  - Nested item",
			"    - Deeper item",
		].join("\n");
		const remoteHash = notionMarkdownContentHash(remoteMarkdown);
		api.getNotionPageMarkdown.mockResolvedValue({
			pageId: "page-id",
			account: "7lab",
			markdown: remoteMarkdown,
			contentHash: remoteHash,
		});
		const { appStore, refreshCurrentNotionPage } = await loadFileActions(api);
		const path = "/workspace/roadmap.md";
		const autosavedMarkdown = linkedPageMarkdown({
			contentHash: remoteHash,
			body: editorSerializedMarkdown(
				remoteMarkdown.replace("---\nStatus: Draft\n---\n", ""),
			),
		});
		setOpenFile(appStore, path, autosavedMarkdown);
		bindFileContent(api, autosavedMarkdown);
		api.listDirectory.mockResolvedValue({
			files: [{ path, modified_at: 2 }],
			folders: [],
		});

		await expect(refreshCurrentNotionPage()).resolves.toEqual({
			kind: "refreshed",
		});

		expect(api.writeFileText).toHaveBeenCalled();
	});

	it("refreshes when autosaved image markdown only drops a render-only title", async () => {
		const api = createDesktopApi();
		const remoteMarkdown = [
			"---",
			"Status: Draft",
			"---",
			'Text ![logo](a.png "Logo")',
		].join("\n");
		const remoteHash = notionMarkdownContentHash(remoteMarkdown);
		api.getNotionPageMarkdown.mockResolvedValue({
			pageId: "page-id",
			account: "7lab",
			markdown: remoteMarkdown,
			contentHash: remoteHash,
		});
		const { appStore, refreshCurrentNotionPage } = await loadFileActions(api);
		const path = "/workspace/roadmap.md";
		const autosavedMarkdown = linkedPageMarkdown({
			contentHash: remoteHash,
			body: "Text\n\n![logo](a.png)",
		});
		setOpenFile(appStore, path, autosavedMarkdown);
		bindFileContent(api, autosavedMarkdown);

		await expect(refreshCurrentNotionPage()).resolves.toEqual({
			kind: "refreshed",
		});

		expect(api.writeFileText).toHaveBeenCalled();
	});

	it("refreshes when autosaved block image markdown only drops a render-only title", async () => {
		const api = createDesktopApi();
		const remoteMarkdown = [
			"---",
			"Status: Draft",
			"---",
			'![logo](a.png "Logo")',
		].join("\n");
		const remoteHash = notionMarkdownContentHash(remoteMarkdown);
		api.getNotionPageMarkdown.mockResolvedValue({
			pageId: "page-id",
			account: "7lab",
			markdown: remoteMarkdown,
			contentHash: remoteHash,
		});
		const { appStore, refreshCurrentNotionPage } = await loadFileActions(api);
		const path = "/workspace/roadmap.md";
		const autosavedMarkdown = linkedPageMarkdown({
			contentHash: remoteHash,
			body: "![logo](a.png)",
		});
		setOpenFile(appStore, path, autosavedMarkdown);
		bindFileContent(api, autosavedMarkdown);

		await expect(refreshCurrentNotionPage()).resolves.toEqual({
			kind: "refreshed",
		});

		expect(api.writeFileText).toHaveBeenCalled();
	});

	it("still blocks refresh when a local block image alt changed", async () => {
		const api = createDesktopApi();
		const remoteMarkdown = "---\nStatus: Draft\n---\n![logo](a.png)";
		api.getNotionPageMarkdown.mockResolvedValue({
			pageId: "page-id",
			account: "7lab",
			markdown: remoteMarkdown,
			contentHash: notionMarkdownContentHash(remoteMarkdown),
		});
		const { appStore, refreshCurrentNotionPage } = await loadFileActions(api);
		const path = "/workspace/roadmap.md";
		const baselineMarkdown = linkedPageMarkdown({
			contentHash: notionMarkdownContentHash(remoteMarkdown),
			body: "![logo](a.png)",
		});
		const editorMarkdown = linkedPageMarkdown({
			contentHash: notionMarkdownContentHash(remoteMarkdown),
			body: "![new logo](a.png)",
		});
		setOpenFile(appStore, path, baselineMarkdown);
		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				content: editorMarkdown,
			},
		}));
		bindFileContent(api, baselineMarkdown);

		await expect(refreshCurrentNotionPage()).resolves.toEqual({
			kind: "local-changes",
		});
		expect(api.writeFileText).not.toHaveBeenCalled();
	});

	it("still blocks refresh when a local block image URL changed", async () => {
		const api = createDesktopApi();
		const remoteMarkdown = "---\nStatus: Draft\n---\n![logo](a.png)";
		api.getNotionPageMarkdown.mockResolvedValue({
			pageId: "page-id",
			account: "7lab",
			markdown: remoteMarkdown,
			contentHash: notionMarkdownContentHash(remoteMarkdown),
		});
		const { appStore, refreshCurrentNotionPage } = await loadFileActions(api);
		const path = "/workspace/roadmap.md";
		const baselineMarkdown = linkedPageMarkdown({
			contentHash: notionMarkdownContentHash(remoteMarkdown),
			body: "![logo](a.png)",
		});
		const editorMarkdown = linkedPageMarkdown({
			contentHash: notionMarkdownContentHash(remoteMarkdown),
			body: "![logo](b.png)",
		});
		setOpenFile(appStore, path, baselineMarkdown);
		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				content: editorMarkdown,
			},
		}));
		bindFileContent(api, baselineMarkdown);

		await expect(refreshCurrentNotionPage()).resolves.toEqual({
			kind: "local-changes",
		});
		expect(api.writeFileText).not.toHaveBeenCalled();
	});

	it("still blocks refresh when a local inline image URL changed", async () => {
		const api = createDesktopApi();
		const remoteMarkdown = "---\nStatus: Draft\n---\nText ![logo](a.png)";
		api.getNotionPageMarkdown.mockResolvedValue({
			pageId: "page-id",
			account: "7lab",
			markdown: remoteMarkdown,
			contentHash: notionMarkdownContentHash(remoteMarkdown),
		});
		const { appStore, refreshCurrentNotionPage } = await loadFileActions(api);
		const path = "/workspace/roadmap.md";
		const baselineMarkdown = linkedPageMarkdown({
			contentHash: notionMarkdownContentHash(remoteMarkdown),
			body: "Text ![logo](a.png)",
		});
		const editorMarkdown = linkedPageMarkdown({
			contentHash: notionMarkdownContentHash(remoteMarkdown),
			body: "Text ![logo](b.png)",
		});
		setOpenFile(appStore, path, baselineMarkdown);
		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				content: editorMarkdown,
			},
		}));
		bindFileContent(api, baselineMarkdown);

		await expect(refreshCurrentNotionPage()).resolves.toEqual({
			kind: "local-changes",
		});
		expect(api.writeFileText).not.toHaveBeenCalled();
	});
});
