// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkIndexStore, resetLinkIndex } from "../store/linkIndexStore";
import { workspaceStore } from "../store/state";
import { DocumentRowList } from "./DocumentRowList";
import { buildRows, viewWith, WORKSPACE_FILES } from "./testFixtures";

const readFileText = vi.hoisted(() => vi.fn());
const loadPath = vi.hoisted(() => vi.fn());

vi.mock("../desktopApi", () => ({
	desktopApi: { readFileText, scanFrontMatterTags: vi.fn(() => ({})) },
}));
vi.mock("../store/actions", async (original) => ({
	...(await original<object>()),
	loadPath,
}));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("saved view grouped by Linked from", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		resetLinkIndex();
		readFileText.mockReset();
		loadPath.mockReset();
		workspaceStore.set((state) => ({
			...state,
			workspacePath: "/ws",
			files: WORKSPACE_FILES,
		}));
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		workspaceStore.set((state) => ({ ...state, workspacePath: null }));
		resetLinkIndex();
	});

	async function render() {
		const view = viewWith({ propertyGroupBy: "group:linkedFrom" });
		await act(async () => {
			root.render(
				<DocumentRowList
					rows={buildRows({ view })}
					density="table"
					view={view}
					onOpenDocument={vi.fn()}
					emptyState={<p>No documents</p>}
				/>,
			);
		});
	}

	it("starts the link index and shows Scanning links… until it lands", async () => {
		readFileText.mockReturnValue(new Promise(() => {}));
		expect(linkIndexStore.get().status).toBe("idle");

		await render();

		expect(readFileText).toHaveBeenCalled();
		expect(
			container.querySelector('[data-tag-scan-state="scanning"]')?.textContent,
		).toContain("Scanning links");
		expect(container.querySelectorAll("[data-group-id]")).toHaveLength(0);
		expect(container.textContent).not.toContain("Other");
	});

	it("renders linker groups once indexed; the title's open button opens the linker", async () => {
		readFileText.mockImplementation(async (path: string) =>
			path === "/ws/alpha.md" ? "[b](notes/beta.markdown)" : "",
		);

		await render();
		await act(async () => {});

		expect(
			container.querySelector('[data-tag-scan-state="scanning"]'),
		).toBeNull();
		const group = container.querySelector(
			'[data-group-id="group:linkedFrom::/ws/alpha.md"]',
		);
		expect(group?.textContent).toContain("alpha");
		expect(
			container.querySelector('[data-group-id="group:linkedFrom::(other)"]'),
		).not.toBeNull();

		await act(async () => {
			group
				?.querySelector("[data-open-group-source]")
				?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(loadPath).toHaveBeenCalledWith("/ws/alpha.md");
	});
});
