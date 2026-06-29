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

		expect(container.textContent).toContain("note-000.md");
		expect(container.textContent).not.toContain("note-239.md");
		expect(container.querySelectorAll("[data-sidebar-index]").length).toBeLessThan(
			80,
		);
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
		return Array.from(container.querySelectorAll("button")).find(
			(candidate) => candidate.textContent?.includes(label),
		);
	}
});
