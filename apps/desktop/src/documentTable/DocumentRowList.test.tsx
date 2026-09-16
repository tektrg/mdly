// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DocumentRowDensity, DocumentRowList } from "./DocumentRowList";
import type { DocumentTableRow } from "./documentTableView";
import { buildRows, manyMarkdownFiles, viewWith } from "./testFixtures";

// The seam `closeDocumentToTable` calls to hand focus back. Mocked so the test
// can invoke the registered callback directly, without standing up the store.
const registeredCloseFocus: { current: (() => void) | null } = {
	current: null,
};
vi.mock("../store/closeDocument", () => ({
	registerDocumentCloseFocus: (takeFocus: () => void) => {
		registeredCloseFocus.current = takeFocus;
		return () => {
			registeredCloseFocus.current = null;
		};
	},
}));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Above `useVirtualSidebarRows`' 120-row threshold, so only a window of rows is
// ever in the DOM. Both defects below are invisible on a short list: the
// existing keyboard test uses three rows, which is why neither was caught.
const VIRTUALIZED_FILES = manyMarkdownFiles(200);

const NEWEST_FIRST = viewWith();
const BY_NAME = viewWith({ sort: { column: "name", direction: "asc" } });

describe("DocumentRowList virtualized behaviour", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function renderRows(
		rows: DocumentTableRow[],
		density: DocumentRowDensity = "table",
	) {
		act(() => {
			root.render(
				<DocumentRowList
					rows={rows}
					density={density}
					sortColumn="modified"
					onOpenDocument={vi.fn()}
					emptyState={<p>No documents</p>}
				/>,
			);
		});
	}

	function scrollContainer(): HTMLElement {
		const el = container.querySelector<HTMLElement>('[role="rowgroup"]');
		if (!el) throw new Error("scroll container not rendered");
		return el;
	}

	function renderedRows(): HTMLElement[] {
		return Array.from(
			container.querySelectorAll<HTMLElement>("[data-document-row-index]"),
		);
	}

	function scrollTo(scrollTop: number) {
		act(() => {
			const el = scrollContainer();
			el.scrollTop = scrollTop;
			el.dispatchEvent(new Event("scroll"));
		});
	}

	describe("H4 — the open document's row is brought into view", () => {
		it("scrolls to the active row when a document is opened off-screen", () => {
			// `/ws/note-0000.md` is the oldest file, so newest-first puts it last.
			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: NEWEST_FIRST,
					activePath: "/ws/note-0000.md",
				}),
			);

			expect(scrollContainer().scrollTop).toBeGreaterThan(0);
		});

		it("scrolls again when the open document changes", () => {
			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: NEWEST_FIRST,
					activePath: "/ws/note-0000.md",
				}),
			);
			scrollTo(0);

			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: NEWEST_FIRST,
					activePath: "/ws/note-0010.md",
				}),
			);

			expect(scrollContainer().scrollTop).toBeGreaterThan(0);
		});

		it("never scrolls on a live re-sort that leaves the same document open", () => {
			// R4's whole point: rows may reorder under a reading user, and the
			// surface must not yank the viewport when they do.
			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: NEWEST_FIRST,
					activePath: "/ws/note-0000.md",
				}),
			);
			scrollTo(1_000);

			// Same open document, brand-new index (last row becomes the first).
			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: BY_NAME,
					activePath: "/ws/note-0000.md",
				}),
			);

			expect(scrollContainer().scrollTop).toBe(1_000);
		});

		it("never scrolls while the filter narrows the list under the same document", () => {
			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: NEWEST_FIRST,
					activePath: "/ws/note-0000.md",
				}),
			);
			scrollTo(1_000);

			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: viewWith({ filter: "note-00" }),
					activePath: "/ws/note-0000.md",
				}),
			);

			expect(scrollContainer().scrollTop).toBe(1_000);
		});
	});

	describe("M4 — exactly one rendered row is always tabbable", () => {
		it("keeps a tabbable row after the list is scrolled past index 0", () => {
			renderRows(buildRows({ files: VIRTUALIZED_FILES, view: NEWEST_FIRST }));
			scrollTo(4_000);

			const rendered = renderedRows();
			expect(rendered.length).toBeGreaterThan(0);
			// Row 0 is far above the virtual window, so a fallback of "index 0"
			// leaves nothing in the tab order and Tab skips the whole list.
			expect(rendered.map((row) => row.dataset.documentRowIndex)).not.toContain(
				"0",
			);
			expect(rendered.filter((row) => row.tabIndex === 0)).toHaveLength(1);
		});

		it("keeps exactly one tabbable row at the top of the list", () => {
			renderRows(buildRows({ files: VIRTUALIZED_FILES, view: NEWEST_FIRST }));

			expect(renderedRows().filter((row) => row.tabIndex === 0)).toHaveLength(
				1,
			);
		});

		it("prefers the active row when it is rendered", () => {
			renderRows(
				buildRows({
					files: VIRTUALIZED_FILES,
					view: NEWEST_FIRST,
					activePath: "/ws/note-0199.md",
				}),
			);

			const tabbable = renderedRows().filter((row) => row.tabIndex === 0);
			expect(tabbable).toHaveLength(1);
			expect(tabbable[0]?.getAttribute("aria-current")).toBe("true");
		});
	});
});

describe("DocumentRowList close-focus seam", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	// Closing a document used to leave focus on `<body>`, so Tab restarted from
	// the top of the window rather than continuing in the list now on screen.
	it("takes focus on the tabbable row after a document closes", () => {
		act(() => {
			root.render(
				<DocumentRowList
					rows={buildRows({ files: manyMarkdownFiles(200) })}
					density="table"
					sortColumn="modified"
					onOpenDocument={vi.fn()}
					emptyState={<p>No documents</p>}
				/>,
			);
		});
		expect(document.activeElement).toBe(document.body);

		// The real seam fires while the *narrow* list is still mounted, so the
		// callback defers a frame; run that frame synchronously.
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			cb(0);
			return 0;
		});
		act(() => registeredCloseFocus.current?.());

		const focused = document.activeElement as HTMLElement | null;
		expect(focused?.getAttribute("data-document-row-index")).not.toBeNull();
		expect(focused?.getAttribute("tabindex")).toBe("0");
	});
});
