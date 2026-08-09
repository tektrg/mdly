// @vitest-environment happy-dom
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Sidebar,
	type SidebarFile,
	type SidebarFolder,
	type SidebarHandle,
} from "./Sidebar";

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

	it("shows no Tags page unless the host supplies a tag handler", async () => {
		await renderSidebar({
			files: [{ path: "/workspace/a.md", tags: ["work"] }],
		});

		expect(container.querySelector('button[aria-label="Tags"]')).toBeNull();
		expect(container.querySelector('[data-sidebar-page="tags"]')).toBeNull();
	});

	it("shows a Tags page with counts, and reports the clicked tag", async () => {
		const onSelectTag = vi.fn();

		await renderSidebar({
			files: [
				{ path: "/workspace/a.md", tags: ["work", "meeting"] },
				{ path: "/workspace/b.md", tags: ["work"] },
			],
			onSelectTag,
		});

		const tagsPage = container.querySelector('[data-sidebar-page="tags"]');
		expect(tagsPage).toBeTruthy();
		// Tags start hidden -- the tree is still page 0.
		expect(tagsPage?.getAttribute("aria-hidden")).toBe("true");

		await clickPagerDot("Tags");
		expect(tagsPage?.getAttribute("aria-hidden")).toBe("false");

		const options = Array.from(
			tagsPage?.querySelectorAll('[role="option"]') ?? [],
		);
		// Sorted by count desc: work(2) before meeting(1).
		expect(options.map((option) => option.textContent)).toEqual([
			"work2",
			"meeting1",
		]);

		await act(async () => {
			(options[0] as HTMLButtonElement).click();
			await Promise.resolve();
		});
		expect(onSelectTag).toHaveBeenCalledWith("work");
	});

	it("narrows the file pages to the active tag while keeping every tag listed", async () => {
		await renderSidebar({
			files: [
				{ path: "/workspace/tagged.md", modifiedAt: 2, tags: ["work"] },
				{ path: "/workspace/other.md", modifiedAt: 1, tags: ["personal"] },
			],
			onSelectTag: vi.fn(),
			activeTag: "work",
		});

		const treePane = container.querySelector('[data-sidebar-page="tree"]');
		expect(treePane?.textContent).toContain("tagged.md");
		expect(treePane?.textContent).not.toContain("other.md");

		const recentPane = container.querySelector('[data-sidebar-page="recent"]');
		expect(recentPane?.textContent).toContain("tagged.md");
		expect(recentPane?.textContent).not.toContain("other.md");

		// Counts still come from the full list, so the user can switch tags.
		await clickPagerDot("Tags");
		const tagsPane = container.querySelector('[data-sidebar-page="tags"]');
		expect(tagsPane?.textContent).toContain("work");
		expect(tagsPane?.textContent).toContain("personal");
	});

	it("marks the active tag as selected", async () => {
		await renderSidebar({
			files: [{ path: "/workspace/a.md", tags: ["work", "meeting"] }],
			onSelectTag: vi.fn(),
			activeTag: "meeting",
		});

		await clickPagerDot("Tags");

		const selected = container.querySelector(
			'[data-sidebar-page="tags"] [role="option"][aria-selected="true"]',
		);
		expect(selected?.textContent).toBe("meeting1");
	});

	it("swipes across all three pages without wrapping past the ends", async () => {
		await renderSidebar({
			files: [{ path: "/workspace/a.md", tags: ["work"] }],
			onSelectTag: vi.fn(),
		});

		const region = container.querySelector("[data-sidebar-swipe-region]");
		expect(region).toBeTruthy();
		const pageShown = () =>
			["tree", "recent", "tags"].find(
				(id) =>
					container
						.querySelector(`[data-sidebar-page="${id}"]`)
						?.getAttribute("aria-hidden") === "false",
			);

		// Each flip starts a cooldown so one physical gesture (many wheel
		// events, plus momentum) only advances one page. Drive a fake clock past
		// it between swipes so this reads as separate gestures, not one flick.
		let now = 1_000_000;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
		const swipe = async (deltaX: number) => {
			now += 500;
			if (region) await dispatchWheel(region, { deltaX, deltaY: 0 });
		};

		try {
			expect(pageShown()).toBe("tree");
			// Backwards at the first page must not wrap around to the last.
			await swipe(-80);
			expect(pageShown()).toBe("tree");

			await swipe(80);
			expect(pageShown()).toBe("recent");
			await swipe(80);
			expect(pageShown()).toBe("tags");
			// ...and forwards at the last page must not wrap around to the first.
			await swipe(80);
			expect(pageShown()).toBe("tags");
			// Still navigable backwards off the end.
			await swipe(-80);
			expect(pageShown()).toBe("recent");
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("shows no Search page unless the host supplies a search handler", async () => {
		await renderSidebar({ files: [{ path: "/workspace/a.md" }] });

		expect(container.querySelector('button[aria-label="Search"]')).toBeNull();
		expect(container.querySelector('[data-sidebar-page="search"]')).toBeNull();
	});

	it("appends Search after Tags", async () => {
		await renderSidebar({
			files: [{ path: "/workspace/a.md", tags: ["work"] }],
			onSelectTag: vi.fn(),
			onSearchChange: vi.fn(),
		});

		expect(
			Array.from(container.querySelectorAll("[data-sidebar-page]")).map(
				(pane) => pane.getAttribute("data-sidebar-page"),
			),
		).toEqual(["tree", "recent", "tags", "search"]);
	});

	it("reports the right page id when Search is on but Tags is off", async () => {
		const onPageChange = vi.fn();

		await renderSidebar({
			files: [{ path: "/workspace/a.md" }],
			onSearchChange: vi.fn(),
			onPageChange,
		});

		await clickPagerDot("Search");

		// Guards against indexing a fixed table of every possible page: that
		// would report "tags" here, and hosts key lazy loading off this string.
		expect(onPageChange).toHaveBeenCalledWith("search");
	});

	it("lists ranked matches for the query and opens the clicked one", async () => {
		const onSelectFile = vi.fn();

		await renderSidebar({
			files: [
				{ path: "/workspace/meeting notes.md" },
				{ path: "/workspace/grocery list.md" },
			],
			onSearchChange: vi.fn(),
			searchQuery: "meeting",
			onSelectFile,
		});

		await clickPagerDot("Search");
		const options = searchOptions();
		expect(options.map((option) => option.textContent)).toEqual([
			"meeting notes.md",
		]);

		await act(async () => {
			(options[0] as HTMLButtonElement).click();
			await Promise.resolve();
		});
		expect(onSelectFile).toHaveBeenCalledWith("/workspace/meeting notes.md");
	});

	it("leaves the Files and Recents pages alone while a query is active", async () => {
		await renderSidebar({
			files: [
				{ path: "/workspace/meeting.md", modifiedAt: 2 },
				{ path: "/workspace/grocery.md", modifiedAt: 1 },
			],
			onSearchChange: vi.fn(),
			searchQuery: "meeting",
		});

		// There is no query box on those pages, so a shortened list there would
		// read as a bug rather than a filter.
		for (const id of ["tree", "recent"]) {
			const pane = container.querySelector(`[data-sidebar-page="${id}"]`);
			expect(pane?.textContent).toContain("meeting.md");
			expect(pane?.textContent).toContain("grocery.md");
		}
	});

	it("scopes search results to the active tag", async () => {
		await renderSidebar({
			files: [
				{ path: "/workspace/tagged note.md", tags: ["work"] },
				{ path: "/workspace/other note.md", tags: ["personal"] },
			],
			onSelectTag: vi.fn(),
			activeTag: "work",
			onSearchChange: vi.fn(),
			searchQuery: "note",
		});

		await clickPagerDot("Search");

		expect(searchOptions().map((option) => option.textContent)).toEqual([
			"tagged note.md",
		]);
	});

	it("moves the highlighted result with the arrow keys while the caret stays in the box", async () => {
		const onSelectFile = vi.fn();

		await renderSidebar({
			files: [
				{ path: "/workspace/note-a.md", modifiedAt: 2 },
				{ path: "/workspace/note-b.md", modifiedAt: 1 },
			],
			onSearchChange: vi.fn(),
			searchQuery: "note",
			onSelectFile,
		});

		await clickPagerDot("Search");
		const input = searchInput();
		input.focus();

		await pressKey(input, "ArrowDown");
		await pressKey(input, "ArrowDown");

		expect(document.activeElement).toBe(input);
		const highlighted = searchOptions()[1];
		expect(input.getAttribute("aria-activedescendant")).toBe(
			highlighted?.getAttribute("id"),
		);

		await pressKey(input, "Enter");
		expect(onSelectFile).toHaveBeenCalledWith("/workspace/note-b.md");
	});

	it("does not hand arrow keys to the tree from the inline rename box", async () => {
		const onSelectFile = vi.fn();

		await renderSidebar({
			files: [
				{ path: "/workspace/note-a.md", modifiedAt: 2 },
				{ path: "/workspace/note-b.md", modifiedAt: 1 },
			],
			onRenameFile: vi.fn(),
			onSelectFile,
		});

		// The rename box sits inside the tree's own keydown container. The
		// allowlist that lets the search box drive its list must never widen to
		// cover this one, or renaming would move the selection instead of the
		// caret.
		const nav = container.querySelector<HTMLElement>(
			'[data-sidebar-page="tree"] [data-sidebar-nav]',
		);
		expect(nav).toBeTruthy();
		await pressKey(nav as HTMLElement, "ArrowDown"); // focus the first row
		await pressKey(nav as HTMLElement, "Enter"); // Enter on a row starts a rename

		const renameBox = container.querySelector<HTMLInputElement>(
			'[data-sidebar-page="tree"] input',
		);
		expect(renameBox).toBeTruthy(); // never let this test pass vacuously

		// Space is the sharpest probe: it is the one key the list would treat as
		// "open the focused row", and the one the search page's allowlist must
		// never claim. If the guard ever widens to ignore editable targets
		// wholesale, typing a space into a file name opens the file instead.
		await pressKey(renameBox as HTMLInputElement, " ");

		expect(onSelectFile).not.toHaveBeenCalled();
	});

	it("clears the query on Escape before giving up focus", async () => {
		const onSearchChange = vi.fn();

		await renderSidebar({
			files: [{ path: "/workspace/note.md" }],
			onSearchChange,
			searchQuery: "note",
		});

		await clickPagerDot("Search");
		await pressKey(searchInput(), "Escape");

		expect(onSearchChange).toHaveBeenCalledWith("");
	});

	it("showPage('search') opens the page and focuses the query box", async () => {
		// switchPage focuses inside a rAF, deliberately: the target pane is still
		// `inert` until React commits the page change, and focus into an inert
		// subtree is a no-op. Queue the frames and drain them after the commit
		// rather than running them inline, which would reproduce that race
		// instead of the real ordering.
		const frames: FrameRequestCallback[] = [];
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.push(callback);
			return frames.length;
		});
		const handle = { current: null as SidebarHandle | null };

		await renderSidebar({
			files: [{ path: "/workspace/note.md" }],
			onSearchChange: vi.fn(),
			handleRef: handle,
		});

		await act(async () => {
			handle.current?.showPage("search");
			await Promise.resolve();
		});
		await act(async () => {
			for (const frame of frames.splice(0)) frame(0);
			await Promise.resolve();
		});

		expect(
			container
				.querySelector('[data-sidebar-page="search"]')
				?.getAttribute("aria-hidden"),
		).toBe("false");
		expect(document.activeElement).toBe(searchInput());
	});

	it("labels results by getDisplayPath, not the raw file name", async () => {
		await renderSidebar({
			files: [{ path: "/workspace/2026-08-08T0912.m4a" }],
			getDisplayPath: () => "Quarterly planning",
			onSearchChange: vi.fn(),
			searchQuery: "quarterly",
		});

		await clickPagerDot("Search");

		expect(searchOptions().map((option) => option.textContent)).toEqual([
			"Quarterly planning",
		]);
	});

	it("keeps the kit's own panel chrome when no chrome prop is given", async () => {
		await renderSidebar({ files: [{ path: "/workspace/a.md" }] });

		expect(container.querySelector("[data-sidebar-root]")).toBeTruthy();
		expect(resizeSeparator()).toBeTruthy();
	});

	it("drops the frame and the resize edge under chrome='none'", async () => {
		await renderSidebar({
			chrome: "none",
			files: [{ path: "/workspace/a.md" }],
		});

		expect(container.querySelector("[data-sidebar-root]")).toBeNull();
		expect(resizeSeparator()).toBeNull();
		expect(container.querySelector("[data-sidebar-body]")).toBeTruthy();
		expect(rowButton("a.md")).toBeTruthy();
	});

	it("keeps the header collapse button under chrome='none'", async () => {
		const onCollapse = vi.fn();
		await renderSidebar({
			chrome: "none",
			files: [{ path: "/workspace/a.md" }],
			onCollapse,
		});

		const toggle = container.querySelector<HTMLButtonElement>(
			'[aria-label="Toggle sidebar"]',
		);
		expect(toggle).toBeTruthy();
		await act(async () => {
			toggle?.click();
			await Promise.resolve();
		});

		expect(onCollapse).toHaveBeenCalledTimes(1);
	});

	it("persists folder expansion but never a width under chrome='none'", async () => {
		await renderSidebar({
			chrome: "none",
			folders: [{ path: "/workspace/notes", modifiedAt: 1 }],
			files: [{ path: "/workspace/notes/a.md", modifiedAt: 1 }],
			storageScope: "ws-1",
		});

		await clickRow("notes");
		expect(container.textContent).toContain("a.md");

		const writes = vi.mocked(localStorage.setItem).mock.calls;
		expect(writes.some(([key]) => key.startsWith("hubble-sidebar-width"))).toBe(
			false,
		);
		const expandedWrites = writes.filter(
			([key]) => key === "hubble-sidebar-expanded-folders:ws-1",
		);
		const lastExpandedWrite = expandedWrites[expandedWrites.length - 1];
		expect(lastExpandedWrite?.[1]).toContain("notes/");
	});

	function resizeSeparator() {
		return container.querySelector(
			'[role="separator"][aria-label="Resize sidebar"]',
		);
	}

	function searchInput() {
		const input = container.querySelector<HTMLInputElement>(
			"[data-sidebar-search]",
		);
		expect(input).toBeTruthy();
		return input as HTMLInputElement;
	}

	function searchOptions() {
		return Array.from(
			container.querySelectorAll(
				'[data-sidebar-page="search"] [role="option"]',
			),
		);
	}

	function pressKey(target: Element, key: string) {
		return act(async () => {
			target.dispatchEvent(
				new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
			);
			await Promise.resolve();
		});
	}

	function clickPagerDot(label: "Files" | "Recent files" | "Tags" | "Search") {
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
		chrome,
		getDisplayPath = (path: string) => path.replace("/workspace/", ""),
		onBrokenSymlink = vi.fn(),
		onCollapse,
		onCopySymlinkTarget = vi.fn(),
		onFocusedItemChange,
		onRenameFile,
		onSelectFile = vi.fn(),
		onSelectTag,
		activeTag = null,
		onPageChange,
		onSearchChange,
		searchQuery,
		storageScope,
		handleRef,
	}: {
		files: SidebarFile[];
		folders?: SidebarFolder[];
		// Opt-in: omitting it must keep the kit's own panel chrome (the default).
		chrome?: Parameters<typeof Sidebar>[0]["chrome"];
		getDisplayPath?: (path: string) => string;
		onBrokenSymlink?: () => void;
		onCollapse?: () => void;
		onCopySymlinkTarget?: (path: string) => void;
		onFocusedItemChange?: Parameters<typeof Sidebar>[0]["onFocusedItemChange"];
		onRenameFile?: (path: string, nextName: string) => void;
		onSelectFile?: (path: string) => void;
		onSelectTag?: (name: string) => void;
		activeTag?: string | null;
		onPageChange?: (pageId: string) => void;
		// Opt-in: every pre-search test omits it and still renders 2 or 3 pages.
		onSearchChange?: (query: string) => void;
		searchQuery?: string;
		storageScope?: string | null;
		handleRef?: { current: SidebarHandle | null };
	}) {
		await act(async () => {
			root.render(
				<Sidebar
					activeTag={activeTag}
					chrome={chrome}
					currentPath={null}
					files={files}
					folders={folders}
					getDisplayPath={getDisplayPath}
					onBrokenSymlink={onBrokenSymlink}
					onCollapse={onCollapse}
					onCopySymlinkTarget={onCopySymlinkTarget}
					onFocusedItemChange={onFocusedItemChange}
					onPageChange={onPageChange}
					onRenameFile={onRenameFile}
					onSearchChange={onSearchChange}
					onSelectFile={onSelectFile}
					onSelectTag={onSelectTag}
					onSortModeChange={vi.fn()}
					ref={handleRef}
					searchQuery={searchQuery}
					sortMode="alpha"
					storageScope={storageScope}
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
