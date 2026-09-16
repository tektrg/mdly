// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatModifiedAt } from "./DocumentRowList";
import { DocumentTable } from "./DocumentTable";
import type { DocumentListingState } from "./documentListingState";
import type { DocumentTableRow } from "./documentTableView";
import {
	buildRows,
	manyMarkdownFiles,
	viewWith,
	WORKSPACE_FILES,
} from "./testFixtures";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED: DocumentListingState = { kind: "listed" };

describe("DocumentTable", () => {
	let container: HTMLDivElement;
	let root: Root;
	let onOpenDocument: ReturnType<typeof vi.fn>;
	let onToggleSort: ReturnType<typeof vi.fn>;
	let onFilterChange: ReturnType<typeof vi.fn>;
	let onRetryListing: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		onOpenDocument = vi.fn();
		onToggleSort = vi.fn();
		onFilterChange = vi.fn();
		onRetryListing = vi.fn();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function renderTable({
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
				<DocumentTable
					rows={rows}
					view={view}
					listing={listing}
					onOpenDocument={onOpenDocument}
					onFilterChange={onFilterChange}
					onToggleSort={onToggleSort}
					onRetryListing={onRetryListing}
				/>,
			);
		});
	}

	function rowElements() {
		return Array.from(container.querySelectorAll<HTMLElement>('[role="row"]'));
	}

	function bodyRowElements() {
		return Array.from(
			container.querySelectorAll<HTMLElement>("[data-document-row-index]"),
		);
	}

	function headerButton(label: string) {
		return rowElements()[0]?.querySelectorAll<HTMLButtonElement>("button")[
			["Name", "Folder", "Modified"].indexOf(label)
		] as HTMLButtonElement;
	}

	it("lists markdown documents only, never HTML apps or images", () => {
		renderTable({ rows: buildRows() });

		const names = bodyRowElements().map(
			(row) => row.querySelectorAll('[role="gridcell"]')[0]?.textContent,
		);
		expect(names).toEqual(["alpha", "beta", "gamma"]);
		expect(container.textContent).not.toContain("app");
		expect(container.textContent).not.toContain("cover");
	});

	it("renders name, folder and modified for each row", () => {
		renderTable({ rows: buildRows() });

		const cells = bodyRowElements()[0]?.querySelectorAll('[role="gridcell"]');
		expect(cells?.[0]?.textContent).toBe("alpha");
		// A document at the workspace root has no folder to name.
		expect(cells?.[1]?.textContent).toBe("—");
		expect(cells?.[2]?.textContent).toBe(formatModifiedAt(1_700_000_300));
		expect(cells?.[2]?.className).toContain("tabular-nums");

		const nested = bodyRowElements()[1]?.querySelectorAll('[role="gridcell"]');
		expect(nested?.[1]?.textContent).toBe("notes");
	});

	it("marks the sorted column with aria-sort and asks to re-sort on header click", () => {
		renderTable({ rows: buildRows() });

		const headers = Array.from(
			container.querySelectorAll<HTMLElement>('[role="columnheader"]'),
		);
		expect(headers.map((header) => header.getAttribute("aria-sort"))).toEqual([
			"none",
			"none",
			"descending",
		]);

		act(() => headerButton("Name").click());
		expect(onToggleSort).toHaveBeenCalledTimes(1);
		expect(onToggleSort).toHaveBeenCalledWith("name");

		renderTable({
			rows: buildRows(),
			view: viewWith({ sort: { column: "name", direction: "asc" } }),
		});
		expect(
			container
				.querySelectorAll('[role="columnheader"]')[0]
				?.getAttribute("aria-sort"),
		).toBe("ascending");
	});

	it("keeps the filter box mounted and focused when the filter matches nothing", () => {
		renderTable({ rows: buildRows({ view: viewWith({ filter: "alp" }) }) });

		const input = container.querySelector<HTMLInputElement>("input");
		expect(input).toBeTruthy();
		act(() => input?.focus());
		expect(document.activeElement).toBe(input);

		// A filter that matches nothing must not unmount the box the user is
		// still typing into.
		renderTable({
			rows: buildRows({ view: viewWith({ filter: "zzzz" }) }),
			view: viewWith({ filter: "zzzz" }),
		});
		const afterFilter = container.querySelector<HTMLInputElement>("input");
		expect(afterFilter).toBe(input);
		expect(document.activeElement).toBe(input);
		expect(bodyRowElements()).toHaveLength(0);
		expect(container.textContent).toContain("No documents match this filter.");
	});

	it("narrows the rows it is given as the filter changes", () => {
		renderTable({
			rows: buildRows({ view: viewWith({ filter: "bet" }) }),
			view: viewWith({ filter: "bet" }),
		});

		expect(
			bodyRowElements().map(
				(row) => row.querySelectorAll('[role="gridcell"]')[0]?.textContent,
			),
		).toEqual(["beta"]);
	});

	it("opens a row exactly once, at the row's openPath", () => {
		const files = [
			...WORKSPACE_FILES,
			{
				path: "/ws/link.md",
				modified_at: 1_700_000_400,
				is_symlink: true,
				symlink_target_exists: true,
				symlink_canonical_path: "/elsewhere/real.md",
			},
		];
		renderTable({ rows: buildRows({ files }) });

		const symlinkRow = bodyRowElements().find((row) =>
			row.textContent?.startsWith("link"),
		);
		act(() => symlinkRow?.click());

		expect(onOpenDocument).toHaveBeenCalledTimes(1);
		expect(onOpenDocument.mock.calls[0]?.[0]?.openPath).toBe(
			"/elsewhere/real.md",
		);
	});

	it("marks exactly one row as the open document, with the selected tokens", () => {
		renderTable({ rows: buildRows({ activePath: "/ws/notes/beta.markdown" }) });

		const active = bodyRowElements().filter(
			(row) => row.getAttribute("aria-current") === "true",
		);
		expect(active).toHaveLength(1);
		expect(active[0]?.textContent).toContain("beta");
		expect(active[0]?.className).toContain("bg-selected");
		expect(active[0]?.className).toContain("text-selected-foreground");
		expect(active[0]?.className).toContain("font-medium");
		// Hover must not repaint the open row. `--accent` and `--selected` differ in
		// opposite directions by theme — accent is lighter in the light themes and
		// darker in the dark ones — so an unguarded `hover:bg-accent` makes the open
		// row read as deselecting itself under the cursor either way.
		expect(active[0]?.className).not.toContain("hover:bg-accent");
	});

	it("uses the app's hover token on idle rows, not the database viewer's outlier", () => {
		renderTable({ rows: buildRows() });

		for (const row of bodyRowElements()) {
			expect(row.className).toContain("hover:bg-accent");
			expect(row.className).not.toContain("bg-muted/40");
		}
	});

	it("glides rows to their new index instead of teleporting, and stops under reduced motion", () => {
		renderTable({ rows: buildRows() });

		const first = bodyRowElements()[0];
		expect(first?.style.transform).toBe("translateY(0px)");
		expect(bodyRowElements()[1]?.style.transform).toBe("translateY(28px)");
		expect(first?.className).toContain("transition-[transform");
		expect(first?.className).toContain("motion-reduce:transition-none");
	});

	it("keeps rows keyboard reachable and visibly focused", () => {
		renderTable({ rows: buildRows() });

		const rows = bodyRowElements();
		expect(rows[0]?.tabIndex).toBe(0);
		expect(rows[1]?.tabIndex).toBe(-1);
		expect(rows[0]?.className).toContain("focus-visible:ring-1");

		act(() => {
			rows[0]?.focus();
			rows[0]?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			);
		});
		expect(document.activeElement).toBe(rows[1]);

		act(() => {
			rows[1]?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
			);
		});
		expect(document.activeElement).toBe(rows[0]);
	});

	it("bounds the DOM row count on a large workspace", () => {
		renderTable({ rows: buildRows({ files: manyMarkdownFiles(1000) }) });

		expect(bodyRowElements().length).toBeGreaterThan(0);
		expect(bodyRowElements().length).toBeLessThan(60);
	});

	describe("R8 — scanning, failed and genuinely empty are three different things", () => {
		it("says it is still looking while the first listing is in flight", () => {
			renderTable({ rows: [], listing: { kind: "scanning" } });

			expect(container.textContent).toContain(
				"Looking for documents in this folder…",
			);
			expect(container.textContent).not.toContain("No documents");
		});

		it("says the folder could not be read, and offers a retry", () => {
			renderTable({
				rows: [],
				listing: { kind: "failed", message: "EACCES: permission denied" },
			});

			expect(container.textContent).toContain("could not be read");
			expect(container.textContent).toContain("EACCES: permission denied");
			expect(container.textContent).not.toContain("No documents");

			const retry = Array.from(container.querySelectorAll("button")).find(
				(button) => button.textContent === "Try again",
			);
			act(() => retry?.click());
			expect(onRetryListing).toHaveBeenCalledTimes(1);
		});

		it("states an empty workspace as one calm muted sentence", () => {
			renderTable({ rows: [], listing: LISTED });

			const empty = container.querySelector<HTMLElement>(
				"p.text-muted-foreground",
			);
			expect(empty?.textContent).toBe("No documents in this workspace yet.");
			expect(bodyRowElements()).toHaveLength(0);
		});
	});
});
