// @vitest-environment happy-dom
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarFile } from "./Sidebar";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ResizeCallback = (entries: { contentRect: { width: number } }[]) => void;

describe("Sidebar responsive list -> table layout", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let resizeCallbacks: ResizeCallback[];
	let renders: number;

	beforeEach(() => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: vi.fn((key: string) => storage.get(key) ?? null),
			setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
		});
		resizeCallbacks = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: ResizeCallback) {
					resizeCallbacks.push(callback);
				}
				observe() {}
				disconnect() {}
			},
		);
		renders = 0;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	const files: SidebarFile[] = [
		{
			path: "/workspace/a.md",
			modifiedAt: new Date(2020, 0, 5).getTime(),
			tags: ["meeting", "draft"],
		},
		{ path: "/workspace/notes/b.md", modifiedAt: 1 },
	];

	async function render(tableBreakpoint?: number) {
		await act(async () => {
			root.render(
				<Sidebar
					files={files}
					currentPath={null}
					sortMode="alpha"
					getDisplayPath={(path) => path.replace("/workspace/", "")}
					onSelectFile={() => {
						renders += 1;
					}}
					tableBreakpoint={tableBreakpoint}
				/>,
			);
		});
	}

	async function resize(width: number) {
		await act(async () => {
			for (const callback of resizeCallbacks) callback([{ contentRect: { width } }]);
		});
	}

	const nav = () =>
		container.querySelector<HTMLElement>("[data-sidebar-nav]");

	it("starts as a compact list with meta inline", async () => {
		await render();
		expect(nav()?.dataset.sidebarLayout).toBe("list");
		expect(container.textContent).toContain("meeting, draft");
		expect(container.querySelector("[data-sidebar-column-hint]")).toBeNull();
	});

	it("switches to table columns when the list's own width crosses the breakpoint", async () => {
		await render(300);
		await resize(320);
		expect(nav()?.dataset.sidebarLayout).toBe("table");
		// Folder row shows the faded column icons above the file columns.
		expect(
			container.querySelectorAll("[data-sidebar-column-hint]").length,
		).toBe(2);
		// Each meta cell keeps one flip id across both layouts.
		expect(
			container.querySelector('[data-flip-id="/workspace/a.md:tags"]'),
		).toBeTruthy();
		expect(
			container.querySelector(
				'[data-flip-id="/workspace/a.md:modified"]',
			),
		).toBeTruthy();

		await resize(200);
		expect(nav()?.dataset.sidebarLayout).toBe("list");
	});

	it("keeps the file row's accessible text to its name (meta is aria-hidden)", async () => {
		await render(300);
		await resize(400);
		for (const cell of container.querySelectorAll("[data-flip-id]")) {
			expect(cell.getAttribute("aria-hidden")).toBe("true");
		}
		expect(renders).toBe(0);
	});
});
