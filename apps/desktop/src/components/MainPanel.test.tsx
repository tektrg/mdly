// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documentTableViewStore } from "../documentTable/documentTableStore";
import { createDefaultDocumentTableView } from "../documentTable/documentTableView";
import { WORKSPACE_FILES } from "../documentTable/testFixtures";
import { viewerStore, workspaceStore } from "../store/state";
import { MainPanel } from "./MainPanel";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const loadPath = vi.hoisted(() => Object.assign(vi.fn(), { cancel: vi.fn() }));
const refreshFiles = vi.hoisted(() => vi.fn());
const closeDocumentToTable = vi.hoisted(() => vi.fn());

vi.mock("../store/actions", () => ({ loadPath, refreshFiles }));
vi.mock("../store/closeDocument", () => ({
	closeDocumentToTable,
	// `DocumentRowList` registers a focus callback on mount; the panel test only
	// cares that mounting succeeds, so hand back an inert unregister.
	registerDocumentCloseFocus: () => () => {},
}));
vi.mock("../desktopApi", () => ({
	desktopApi: { readRevisionContent: vi.fn() },
}));
vi.mock("./DocumentViewer", () => ({
	DocumentViewer: ({ path }: { path: string }) => (
		<div data-testid="document-viewer">{path}</div>
	),
}));
vi.mock("./RevisionHistoryPanel", () => ({
	RevisionHistoryPanel: () => null,
}));
vi.mock("./WelcomeScreen", () => ({
	WelcomeScreen: () => <div data-testid="welcome-screen" />,
}));

const OPEN_PATH = "/ws/alpha.md";

describe("MainPanel", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		loadPath.mockClear();
		closeDocumentToTable.mockClear();
		documentTableViewStore.set(createDefaultDocumentTableView());
		workspaceStore.set((workspace) => ({
			...workspace,
			workspacePath: "/ws",
			files: WORKSPACE_FILES,
			hasListedOnce: true,
			listingError: null,
		}));
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function renderPanel({
		hasWorkspace = true,
	}: {
		hasWorkspace?: boolean;
	} = {}) {
		act(() => {
			root.render(
				<MainPanel
					hasWorkspace={hasWorkspace}
					onCreateFolder={vi.fn()}
					onOpenFolder={vi.fn()}
					notionDatabaseRefreshToken={0}
					onScrollContainerChange={vi.fn()}
					historyOpen={false}
					onHistoryOpenChange={vi.fn()}
					commentsOpen={false}
					onCommentsOpenChange={vi.fn()}
					viewingRevision={null}
					onViewingRevisionChange={vi.fn()}
				/>,
			);
		});
	}

	function setViewer(document: {
		requestedPath: string | null;
		currentPath?: string | null;
		status: "idle" | "loading" | "ready" | "error";
		error?: string | null;
	}) {
		act(() => {
			viewerStore.set((state) => ({
				...state,
				requestedPath: document.requestedPath,
				currentPath: document.currentPath ?? null,
				status: document.status,
				error: document.error ?? null,
				content: "",
				diskContent: "",
			}));
		});
	}

	function listRows() {
		return Array.from(
			container.querySelectorAll<HTMLElement>("[data-document-row-index]"),
		);
	}

	function documentPane() {
		return container.querySelector<HTMLElement>("[data-document-pane]");
	}

	it("shows the welcome screen when there is no workspace", () => {
		setViewer({ requestedPath: null, status: "idle" });
		renderPanel({ hasWorkspace: false });

		expect(
			container.querySelector('[data-testid="welcome-screen"]'),
		).toBeTruthy();
		expect(documentPane()).toBeNull();
		expect(listRows()).toHaveLength(0);
	});

	it("is the full-width table when no document is requested", () => {
		setViewer({ requestedPath: null, status: "idle" });
		renderPanel();

		expect(container.querySelectorAll('[role="columnheader"]')).toHaveLength(3);
		expect(listRows()).toHaveLength(3);
		expect(documentPane()).toBeNull();
		expect(
			container.querySelector('[data-testid="document-viewer"]'),
		).toBeNull();
	});

	it("keeps the list on screen and clickable while a document is still opening", () => {
		setViewer({ requestedPath: OPEN_PATH, status: "loading" });
		renderPanel();

		expect(documentPane()?.textContent).toContain("Opening this document…");
		const rows = listRows();
		expect(rows).toHaveLength(3);
		// The loading state belongs to the pane, never to the list.
		expect(
			documentPane()?.querySelector("[data-document-row-index]"),
		).toBeNull();

		act(() => rows[2]?.click());
		expect(loadPath).toHaveBeenCalledTimes(1);
		expect(loadPath).toHaveBeenCalledWith("/ws/notes/deep/gamma.md");
	});

	it("keeps the list on screen and clickable after a failed open", () => {
		setViewer({
			requestedPath: OPEN_PATH,
			status: "error",
			error: "ENOENT: no such file",
		});
		renderPanel();

		expect(documentPane()?.textContent).toContain("ENOENT: no such file");
		const rows = listRows();
		expect(rows).toHaveLength(3);
		expect(
			rows.filter((row) => row.getAttribute("aria-current") === "true"),
		).toHaveLength(1);

		act(() => rows[1]?.click());
		expect(loadPath).toHaveBeenCalledTimes(1);
	});

	it("returns to the table from All documents, mid-failure included", () => {
		setViewer({ requestedPath: OPEN_PATH, status: "error", error: "boom" });
		renderPanel();

		const allDocuments = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "All documents",
		);
		act(() => allDocuments?.click());
		expect(closeDocumentToTable).toHaveBeenCalledTimes(1);
	});

	it("mounts exactly one document view, inside the pane, when the document is ready", () => {
		setViewer({
			requestedPath: OPEN_PATH,
			currentPath: OPEN_PATH,
			status: "ready",
		});
		renderPanel();

		const viewers = container.querySelectorAll(
			'[data-testid="document-viewer"]',
		);
		expect(viewers).toHaveLength(1);
		expect(documentPane()?.contains(viewers[0] as Node)).toBe(true);
		expect(listRows()).toHaveLength(3);
	});
});
