// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentNarrowList } from "./DocumentNarrowList";
import { formatModifiedAt } from "./DocumentRowList";
import type { DocumentListingState } from "./documentListingState";
import type { DocumentTableRow } from "./documentTableView";
import { buildRows, viewWith } from "./testFixtures";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED: DocumentListingState = { kind: "listed" };

describe("DocumentNarrowList", () => {
	let container: HTMLDivElement;
	let root: Root;
	let onOpenDocument: ReturnType<typeof vi.fn>;
	let onShowAllDocuments: ReturnType<typeof vi.fn>;
	let onFilterChange: ReturnType<typeof vi.fn>;
	let onRetryListing: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		onOpenDocument = vi.fn();
		onShowAllDocuments = vi.fn();
		onFilterChange = vi.fn();
		onRetryListing = vi.fn();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function renderList({
		rows,
		view = viewWith(),
		listing = LISTED,
	}: {
		rows: DocumentTableRow[];
		view?: ReturnType<typeof viewWith>;
		listing?: DocumentListingState;
	}) {
		act(() => {
			root.render(
				<DocumentNarrowList
					rows={rows}
					view={view}
					listing={listing}
					onOpenDocument={onOpenDocument}
					onFilterChange={onFilterChange}
					onShowAllDocuments={onShowAllDocuments}
					onRetryListing={onRetryListing}
				/>,
			);
		});
	}

	function bodyRowElements() {
		return Array.from(
			container.querySelectorAll<HTMLElement>("[data-document-row-index]"),
		);
	}

	function secondaryLines() {
		return bodyRowElements().map(
			(row) => row.querySelector('[role="gridcell"]')?.children[1]?.textContent,
		);
	}

	it("shows the folder under each name while sorting by name", () => {
		const view = viewWith({ sort: { column: "name", direction: "asc" } });
		renderList({ rows: buildRows({ view }), view });

		expect(secondaryLines()).toEqual(["—", "notes", "notes/deep"]);
	});

	it("shows the timestamp under each name while sorting by modified", () => {
		renderList({ rows: buildRows() });

		expect(secondaryLines()[0]).toBe(formatModifiedAt(1_700_000_300));
	});

	it("returns to the full-width table from the All documents row", () => {
		renderList({ rows: buildRows({ activePath: "/ws/alpha.md" }) });

		const allDocuments = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "All documents",
		);
		expect(allDocuments).toBeTruthy();

		act(() => allDocuments?.click());
		expect(onShowAllDocuments).toHaveBeenCalledTimes(1);
	});

	it("keeps the open document pinned as the active row when the filter hides it", () => {
		const view = viewWith({ filter: "gam" });
		renderList({
			rows: buildRows({ view, activePath: "/ws/alpha.md" }),
			view,
		});

		const rows = bodyRowElements();
		expect(rows.map((row) => row.textContent?.startsWith("alpha"))).toContain(
			true,
		);
		expect(
			rows.filter((row) => row.getAttribute("aria-current") === "true"),
		).toHaveLength(1);
	});

	it("selects nothing for a document the table has no business showing", () => {
		renderList({ rows: buildRows({ activePath: "/ws/app.html" }) });

		expect(
			bodyRowElements().filter(
				(row) => row.getAttribute("aria-current") === "true",
			),
		).toHaveLength(0);
		expect(container.textContent).not.toContain("app");
	});

	// D3c: the full-width table offers "Try again" after a failed listing but
	// this list did not, so with a document open the only escape from a folder
	// that blipped was refocusing the window.
	it("offers the same retry the full-width table does after a failed listing", () => {
		renderList({
			rows: [],
			listing: { kind: "failed", message: "EIO: volume went away" },
		});

		const retry = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Try again",
		);
		expect(retry).toBeTruthy();

		act(() => retry?.click());
		expect(onRetryListing).toHaveBeenCalledTimes(1);
	});

	// R8's three states have to stay three different sentences.
	it("tells a still-running scan, a failed one and an empty folder apart", () => {
		renderList({ rows: [], listing: { kind: "scanning" } });
		expect(container.textContent).toContain("Looking for documents");

		renderList({ rows: [], listing: { kind: "failed", message: "EACCES" } });
		expect(container.textContent).toContain("could not be read");

		renderList({ rows: [], listing: LISTED });
		expect(container.textContent).toContain("No documents in this workspace");
	});

	it("stays clickable while the list is empty of matches", () => {
		const view = viewWith({ filter: "zzzz" });
		renderList({ rows: buildRows({ view }), view });

		expect(container.querySelector("input")).toBeTruthy();
		const allDocuments = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "All documents",
		);
		act(() => allDocuments?.click());
		expect(onShowAllDocuments).toHaveBeenCalledTimes(1);
	});
});
