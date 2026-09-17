// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentGroupHeader } from "./DocumentGroupHeader";
import { DocumentNarrowList } from "./DocumentNarrowList";
import { DocumentTable } from "./DocumentTable";
import type { DocumentListingState } from "./documentListingState";
import { buildRows, viewWith } from "./testFixtures";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LISTED: DocumentListingState = { kind: "listed" };

describe("nav strips", () => {
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

	it("DocumentTable renders both nav strip hooks", () => {
		act(() => {
			root.render(
				<DocumentTable
					rows={buildRows()}
					view={viewWith()}
					listing={LISTED}
					onOpenDocument={vi.fn()}
					onFilterChange={vi.fn()}
					onToggleSort={vi.fn()}
					onRetryListing={vi.fn()}
				/>,
			);
		});

		const listHeader = container.querySelector("[data-nav-list-header]");
		const footerStrip = container.querySelector("[data-nav-footer-strip]");
		expect(listHeader).not.toBeNull();
		expect(footerStrip).not.toBeNull();
	});

	it("DocumentNarrowList renders both nav strip hooks", () => {
		act(() => {
			root.render(
				<DocumentNarrowList
					rows={buildRows()}
					view={viewWith()}
					listing={LISTED}
					onOpenDocument={vi.fn()}
					onFilterChange={vi.fn()}
					onShowAllDocuments={vi.fn()}
					onRetryListing={vi.fn()}
				/>,
			);
		});

		const listHeader = container.querySelector("[data-nav-list-header]");
		const footerStrip = container.querySelector("[data-nav-footer-strip]");
		expect(listHeader).not.toBeNull();
		expect(footerStrip).not.toBeNull();
	});

	it("DocumentGroupHeader clamps depth9 paddingInlineStart to depth4", () => {
		const depth4 = renderGroupHeaderPadding(4);
		const depth9 = renderGroupHeaderPadding(9);

		expect(depth9).toBe(depth4);
	});

	it("DocumentGroupHeader depth0 paddingInlineStart is numerically smaller than depth2", () => {
		const depth0 = renderGroupHeaderPadding(0);
		const depth2 = renderGroupHeaderPadding(2);

		expect(parseFloat(depth0)).toBeLessThan(parseFloat(depth2));
	});

	function renderGroupHeaderPadding(depth: number): string {
		act(() => {
			root.render(
				<DocumentGroupHeader
					label="Group"
					count={1}
					depth={depth}
					expanded={false}
					onToggle={vi.fn()}
					specId="spec"
					groupId="group"
				/>,
			);
		});
		const node = container.querySelector<HTMLElement>("[data-group-id]");
		if (!node) throw new Error("group header not rendered");
		expect(node.style.paddingInlineStart).not.toBe("");
		return node.style.paddingInlineStart;
	}
});
