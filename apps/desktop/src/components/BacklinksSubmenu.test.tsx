// @vitest-environment happy-dom
import { Menu } from "@base-ui/react/menu";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkIndexStore, resetLinkIndex } from "../store/linkIndexStore";
import { workspacePathStore, workspaceStore } from "../store/state";
import {
	BACKLINKS_MENU_VISIBLE_ITEMS,
	BacklinksSubmenu,
} from "./BacklinksSubmenu";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const loadPath = vi.hoisted(() => vi.fn());
const disk = vi.hoisted(() => ({}) as Record<string, string>);
vi.mock("../store/actions", () => ({ loadPath }));
vi.mock("../desktopApi", () => ({
	desktopApi: {
		readFileText: vi.fn(async (path: string) => disk[path] ?? ""),
	},
}));

let container: HTMLDivElement;
let root: Root;

function setFiles(paths: string[]) {
	workspaceStore.set((state) => ({
		...state,
		files: paths.map((path) => ({ path, modified_at: 1 })),
	}));
}

async function renderMenu(path = "/ws/target.md") {
	await act(async () => {
		root.render(
			<Menu.Root open>
				<Menu.Portal>
					<Menu.Positioner>
						<Menu.Popup>
							<BacklinksSubmenu path={path} />
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>,
		);
	});
}

async function openSubmenu() {
	const trigger = [...document.querySelectorAll("[role=menuitem]")].find((el) =>
		el.textContent?.startsWith("Backlinks"),
	) as HTMLElement;
	await act(async () => {
		trigger.click();
	});
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});
}

function items() {
	return [...document.querySelectorAll("[data-backlink-item]")].map(
		(el) => el.textContent,
	);
}

beforeEach(() => {
	resetLinkIndex();
	loadPath.mockReset();
	for (const key of Object.keys(disk)) delete disk[key];
	workspacePathStore.set("/ws");
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	document.body.innerHTML = "";
});

describe("BacklinksSubmenu", () => {
	it("starts the index sync and lists linking docs A→Z with a count", async () => {
		disk["/ws/zeta.md"] = "[t](target.md)";
		disk["/ws/alpha.md"] = "[[target]]";
		disk["/ws/target.md"] = "";
		setFiles(["/ws/zeta.md", "/ws/alpha.md", "/ws/target.md"]);
		await renderMenu();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(linkIndexStore.get().status).toBe("ready");
		expect(document.body.textContent).toContain("Backlinks (2)");
		await openSubmenu();
		expect(items()).toEqual(["alpha", "zeta"]);
	});

	it("opens the linking doc on click", async () => {
		disk["/ws/alpha.md"] = "[t](target.md)";
		setFiles(["/ws/alpha.md", "/ws/target.md"]);
		await renderMenu();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});
		await openSubmenu();
		const item = document.querySelector("[data-backlink-item]") as HTMLElement;
		await act(async () => item.click());
		expect(loadPath).toHaveBeenCalledWith("/ws/alpha.md");
	});

	it("shows a disabled 'No backlinks' when nothing links here", async () => {
		setFiles(["/ws/alpha.md", "/ws/target.md"]);
		await renderMenu();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(document.body.textContent).toContain("Backlinks (0)");
		await openSubmenu();
		const empty = [...document.querySelectorAll("[role=menuitem]")].find(
			(el) => el.textContent === "No backlinks",
		);
		expect(empty?.getAttribute("aria-disabled")).toBe("true");
	});

	it("shows 'Scanning links…' while the index builds", async () => {
		setFiles([]);
		workspacePathStore.set(undefined);
		linkIndexStore.set((s) => ({ ...s, status: "indexing" }));
		await renderMenu();
		expect(document.body.textContent).toContain("Backlinks");
		await openSubmenu();
		expect(document.body.textContent).toContain("Scanning links…");
	});

	it("scrolls instead of truncating a long list", async () => {
		const linkers = Array.from(
			{ length: BACKLINKS_MENU_VISIBLE_ITEMS + 5 },
			(_, i) => `/ws/n${String(i).padStart(2, "0")}.md`,
		);
		for (const p of linkers) disk[p] = "[t](target.md)";
		setFiles([...linkers, "/ws/target.md"]);
		await renderMenu();
		await act(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});
		await openSubmenu();
		expect(items()).toHaveLength(linkers.length);
		const list = document.querySelector("[data-backlink-list]") as HTMLElement;
		expect(list.className).toContain("overflow-y-auto");
	});
});

it("the Backlinks panel module is gone", async () => {
	const modules = import.meta.glob("./BacklinksPanel.tsx");
	expect(Object.keys(modules)).toEqual([]);
});
