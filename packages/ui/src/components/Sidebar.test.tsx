// @vitest-environment happy-dom
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarFile, type SidebarFolder } from "./Sidebar";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Sidebar symlink activation", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: vi.fn((key: string) => storage.get(key) ?? null),
			setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
		});
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	it("opens the canonical file path for in-workspace file symlinks", async () => {
		const onSelectFile = vi.fn();

		await renderSidebar({
			files: [
				{
					path: "/workspace/link.md",
					isSymlink: true,
					symlinkTargetExists: true,
					symlinkTargetInWorkspace: true,
					symlinkCanonicalPath: "/workspace/target.md",
				},
			],
			onSelectFile,
		});

		await clickRow("link.md");

		expect(onSelectFile).toHaveBeenCalledWith("/workspace/target.md");
	});

	it("copies the target for external symlinks", async () => {
		const onSelectFile = vi.fn();
		const onCopySymlinkTarget = vi.fn();

		await renderSidebar({
			files: [
				{
					path: "/workspace/external.md",
					isSymlink: true,
					symlinkTarget: "/external/target.md",
					symlinkTargetExists: true,
					symlinkTargetInWorkspace: false,
				},
			],
			onCopySymlinkTarget,
			onSelectFile,
		});

		await clickRow("external.md");

		expect(onCopySymlinkTarget).toHaveBeenCalledWith("/external/target.md");
		expect(onSelectFile).not.toHaveBeenCalled();
	});

	it("copies external folder symlink targets without expanding contents", async () => {
		const onCopySymlinkTarget = vi.fn();

		await renderSidebar({
			folders: [
				{
					path: "/workspace/external-folder",
					isSymlink: true,
					symlinkTarget: "/external/folder",
					symlinkTargetExists: true,
					symlinkTargetInWorkspace: false,
				},
			],
			files: [],
			onCopySymlinkTarget,
		});

		const row = rowButton("external-folder");
		expect(row?.querySelector("[data-sidebar-chevron] svg")).toBeNull();

		await clickRow("external-folder");

		expect(onCopySymlinkTarget).toHaveBeenCalledWith("/external/folder");
	});

	it("renders a bounded window for large sidebars", async () => {
		await renderSidebar({
			files: Array.from({ length: 240 }, (_, index) => ({
				path: `/workspace/note-${index.toString().padStart(3, "0")}.md`,
				modifiedAt: index,
			})),
		});
		const treePane = container.querySelector('[data-sidebar-page="tree"]');

		expect(treePane?.textContent).toContain("note-000.md");
		expect(treePane?.textContent).not.toContain("note-239.md");
		expect(
			treePane?.querySelectorAll("[data-sidebar-index]").length,
		).toBeLessThan(80);
	});

	it("does not propagate row hover as focused app state", async () => {
		const onFocusedItemChange = vi.fn();

		await renderSidebar({
			files: [{ path: "/workspace/note.md", modifiedAt: 1 }],
			onFocusedItemChange,
		});
		onFocusedItemChange.mockClear();

		const row = container.querySelector("[data-sidebar-index='0']");
		expect(row).toBeTruthy();
		await act(async () => {
			row?.dispatchEvent(new Event("pointerenter", { bubbles: true }));
			row?.dispatchEvent(new Event("pointerleave", { bubbles: true }));
			await Promise.resolve();
		});

		expect(onFocusedItemChange).not.toHaveBeenCalled();
	});

	it("expands and focuses the canonical folder for in-workspace folder symlinks", async () => {
		const onFocusedItemChange = vi.fn();

		await renderSidebar({
			folders: [
				{ path: "/workspace/skills", modifiedAt: 1 },
				{ path: "/workspace/skills/gws-util", modifiedAt: 2 },
				{
					path: "/workspace/link",
					isSymlink: true,
					symlinkTargetExists: true,
					symlinkTargetInWorkspace: true,
					symlinkCanonicalPath: "/workspace/skills/gws-util",
				},
			],
			files: [{ path: "/workspace/skills/gws-util/note.md", modifiedAt: 1 }],
			onFocusedItemChange,
		});

		await clickRow("link");

		expect(onFocusedItemChange).toHaveBeenCalledWith({
			kind: "folder",
			folderId: "skills/gws-util/",
		});
		expect(container.textContent).toContain("note.md");
	});

	it("reports broken symlinks without opening or copying", async () => {
		const onBrokenSymlink = vi.fn();
		const onCopySymlinkTarget = vi.fn();
		const onSelectFile = vi.fn();

		await renderSidebar({
			files: [
				{
					path: "/workspace/broken.md",
					isSymlink: true,
					symlinkTarget: "/workspace/missing.md",
					symlinkTargetExists: false,
				},
			],
			onBrokenSymlink,
			onCopySymlinkTarget,
			onSelectFile,
		});

		await clickRow("broken.md");

		expect(onBrokenSymlink).toHaveBeenCalled();
		expect(onCopySymlinkTarget).not.toHaveBeenCalled();
		expect(onSelectFile).not.toHaveBeenCalled();
	});

	it("recent-files page lists files flat with no folder rows, and starts hidden", async () => {
		await renderSidebar({
			folders: [{ path: "/workspace/notes", modifiedAt: 1 }],
			files: [
				{ path: "/workspace/notes/a.md", modifiedAt: 2 },
				{ path: "/workspace/b.md", modifiedAt: 1 },
			],
		});

		const treePane = container.querySelector('[data-sidebar-page="tree"]');
		const recentPane = container.querySelector('[data-sidebar-page="recent"]');
		expect(treePane?.getAttribute("aria-hidden")).not.toBe("true");
		expect(recentPane?.getAttribute("aria-hidden")).toBe("true");
		expect(recentPane?.textContent).toContain("a.md");
		expect(recentPane?.textContent).toContain("b.md");
		expect(recentPane?.querySelector("[data-sidebar-chevron]")).toBeNull();
	});

	it("switches to the recent-files page via the pager dot and back via the tree dot", async () => {
		await renderSidebar({
			files: [{ path: "/workspace/note.md", modifiedAt: 1 }],
		});

		await clickPagerDot("Recent files");
		expect(
			container
				.querySelector('[data-sidebar-page="recent"]')
				?.getAttribute("aria-hidden"),
		).not.toBe("true");
		expect(
			container
				.querySelector('[data-sidebar-page="tree"]')
				?.getAttribute("aria-hidden"),
		).toBe("true");

		await clickPagerDot("Files");
		expect(
			container
				.querySelector('[data-sidebar-page="tree"]')
				?.getAttribute("aria-hidden"),
		).not.toBe("true");
	});

	it("switches pages on a horizontal-dominant swipe but not on vertical scrolling", async () => {
		await renderSidebar({
			files: [{ path: "/workspace/note.md", modifiedAt: 1 }],
		});
		const swipeRegion = container.querySelector("[data-sidebar-swipe-region]");
		expect(swipeRegion).toBeTruthy();

		await dispatchWheel(swipeRegion as Element, { deltaX: 0, deltaY: 300 });
		expect(
			container
				.querySelector('[data-sidebar-page="recent"]')
				?.getAttribute("aria-hidden"),
		).toBe("true");

		await dispatchWheel(swipeRegion as Element, { deltaX: 200, deltaY: 0 });
		expect(
			container
				.querySelector('[data-sidebar-page="recent"]')
				?.getAttribute("aria-hidden"),
		).not.toBe("true");
	});

	it("caps the recent-files page to the 100 most recent files and shows a hint past that boundary", async () => {
		await renderSidebar({
			files: Array.from({ length: 150 }, (_, index) => ({
				path: `/workspace/note-${index.toString().padStart(3, "0")}.md`,
				modifiedAt: index,
			})),
		});

		await clickPagerDot("Recent files");
		const recentPane = container.querySelector('[data-sidebar-page="recent"]');

		expect(recentPane?.querySelectorAll("[data-sidebar-index]").length).toBe(
			100,
		);
		expect(recentPane?.textContent).toContain("note-149.md");
		expect(recentPane?.textContent).not.toContain("note-049.md");
		expect(recentPane?.textContent).toContain("Showing 100 most recent files");
	});

	it("hides the recent-files hint at exactly 100 files, and never shows it on the tree page", async () => {
		await renderSidebar({
			files: Array.from({ length: 100 }, (_, index) => ({
				path: `/workspace/note-${index.toString().padStart(3, "0")}.md`,
				modifiedAt: index,
			})),
		});

		await clickPagerDot("Recent files");
		const recentPane = container.querySelector('[data-sidebar-page="recent"]');
		const treePane = container.querySelector('[data-sidebar-page="tree"]');

		expect(recentPane?.textContent).not.toContain(
			"Showing 100 most recent files",
		);
		expect(treePane?.textContent).not.toContain("most recent files");
	});

	it("opens a file from the recent-files page with no action-menu affordance", async () => {
		const onSelectFile = vi.fn();
		await renderSidebar({
			files: [
				{ path: "/workspace/notes/a.md", modifiedAt: 2 },
				{ path: "/workspace/b.md", modifiedAt: 1 },
			],
			onSelectFile,
		});

		await clickPagerDot("Recent files");
		const recentPane = container.querySelector('[data-sidebar-page="recent"]');
		expect(recentPane?.querySelector('[aria-label^="Actions for"]')).toBeNull();

		const row = Array.from(recentPane?.querySelectorAll("button") ?? []).find(
			(candidate) => candidate.textContent?.includes("a.md"),
		);
		await act(async () => {
			row?.click();
			await Promise.resolve();
		});

		expect(onSelectFile).toHaveBeenCalledWith("/workspace/notes/a.md");
	});

	it("keeps tree scroll/expansion state after flipping to the recent-files page and back", async () => {
		await renderSidebar({
			folders: [{ path: "/workspace/notes", modifiedAt: 1 }],
			files: [{ path: "/workspace/notes/a.md", modifiedAt: 1 }],
		});

		await clickRow("notes");
		expect(container.textContent).toContain("a.md");

		await clickPagerDot("Recent files");
		await clickPagerDot("Files");

		const treePane = container.querySelector('[data-sidebar-page="tree"]');
		expect(treePane?.textContent).toContain("a.md");
	});

	function clickPagerDot(label: "Files" | "Recent files") {
		return act(async () => {
			container
				.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
				?.click();
			await Promise.resolve();
		});
	}

	function dispatchWheel(
		target: Element,
		delta: { deltaX: number; deltaY: number },
	) {
		return act(async () => {
			target.dispatchEvent(
				new WheelEvent("wheel", {
					bubbles: true,
					cancelable: true,
					deltaX: delta.deltaX,
					deltaY: delta.deltaY,
				}),
			);
			await Promise.resolve();
		});
	}

	async function renderSidebar({
		files,
		folders = [],
		onBrokenSymlink = vi.fn(),
		onCopySymlinkTarget = vi.fn(),
		onFocusedItemChange,
		onSelectFile = vi.fn(),
	}: {
		files: SidebarFile[];
		folders?: SidebarFolder[];
		onBrokenSymlink?: () => void;
		onCopySymlinkTarget?: (path: string) => void;
		onFocusedItemChange?: Parameters<typeof Sidebar>[0]["onFocusedItemChange"];
		onSelectFile?: (path: string) => void;
	}) {
		await act(async () => {
			root.render(
				<Sidebar
					currentPath={null}
					files={files}
					folders={folders}
					getDisplayPath={(path) => path.replace("/workspace/", "")}
					onBrokenSymlink={onBrokenSymlink}
					onCopySymlinkTarget={onCopySymlinkTarget}
					onFocusedItemChange={onFocusedItemChange}
					onSelectFile={onSelectFile}
					onSortModeChange={vi.fn()}
					sortMode="alpha"
				/>,
			);
			await Promise.resolve();
		});
	}

	async function clickRow(label: string) {
		const button = rowButton(label);
		expect(button).toBeTruthy();
		await act(async () => {
			button?.click();
			await Promise.resolve();
		});
	}

	function rowButton(label: string) {
		return Array.from(container.querySelectorAll("button")).find((candidate) =>
			candidate.textContent?.includes(label),
		);
	}
});
