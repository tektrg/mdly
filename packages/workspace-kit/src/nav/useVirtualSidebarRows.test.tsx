// @vitest-environment happy-dom
import { act, useEffect, useMemo } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	SIDEBAR_VIRTUAL_ROW_HEIGHT,
	useVirtualSidebarRows,
} from "./useVirtualSidebarRows";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** The document table's own row height, the other height this hook is used at. */
const DOCUMENT_TABLE_ROW_HEIGHT = 44;
/** A normal window's list viewport: overflows at ~9 table rows / ~14 sidebar rows. */
const VIEWPORT_HEIGHT = 400;
/** Matches `DEFAULT_VIRTUALIZATION_THRESHOLD` in the hook. */
const VIRTUALIZATION_THRESHOLD = 120;

describe("useVirtualSidebarRows scrollToIndex", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	/**
	 * Renders the hook against a detached scroll element whose viewport height is
	 * stubbed (happy-dom reports 0 for every layout metric), and returns that
	 * element plus the hook's `scrollToIndex`.
	 */
	function mountList({
		rowCount,
		rowHeight,
		viewportHeight = VIEWPORT_HEIGHT,
	}: {
		rowCount: number;
		rowHeight: number;
		viewportHeight?: number;
	}) {
		const scrollEl = document.createElement("div");
		Object.defineProperty(scrollEl, "clientHeight", { value: viewportHeight });
		const scrollRef = { current: scrollEl as HTMLElement | null };
		const captured: { scrollToIndex: (index: number) => void } = {
			scrollToIndex: () => {},
		};

		function Harness({ count }: { count: number }) {
			const rows = useMemo(
				() => Array.from({ length: count }, (_, index) => index),
				[count],
			);
			const { scrollToIndex } = useVirtualSidebarRows({
				rowHeight,
				rows,
				scrollRef,
			});
			useEffect(() => {
				captured.scrollToIndex = scrollToIndex;
			}, [scrollToIndex]);
			return null;
		}

		const renderWithRowCount = (count: number) =>
			act(() => root.render(<Harness count={count} />));
		renderWithRowCount(rowCount);
		return {
			scrollEl,
			renderWithRowCount,
			currentScrollToIndex: () => captured.scrollToIndex,
			scrollToIndex: (index: number) =>
				act(() => captured.scrollToIndex(index)),
		};
	}

	describe("lists that overflow but stay under the virtualization threshold", () => {
		it("scrolls a below-the-fold row into view in a 44px document-table list", () => {
			const { scrollEl, scrollToIndex } = mountList({
				rowCount: 60,
				rowHeight: DOCUMENT_TABLE_ROW_HEIGHT,
			});

			scrollToIndex(59);

			// Bottom-aligned: row bottom (60 * 44) minus the 400px viewport.
			expect(scrollEl.scrollTop).toBe(60 * DOCUMENT_TABLE_ROW_HEIGHT - 400);
		});

		it("scrolls a below-the-fold row into view in a 28px sidebar list", () => {
			const { scrollEl, scrollToIndex } = mountList({
				rowCount: 60,
				rowHeight: SIDEBAR_VIRTUAL_ROW_HEIGHT,
			});

			scrollToIndex(59);

			expect(scrollEl.scrollTop).toBe(60 * SIDEBAR_VIRTUAL_ROW_HEIGHT - 400);
		});

		it("scrolls back up to a row above the viewport", () => {
			const { scrollEl, scrollToIndex } = mountList({
				rowCount: 60,
				rowHeight: SIDEBAR_VIRTUAL_ROW_HEIGHT,
			});
			scrollEl.scrollTop = 1_000;

			scrollToIndex(0);

			expect(scrollEl.scrollTop).toBe(0);
		});
	});

	describe("lists above the virtualization threshold", () => {
		it("still scrolls a below-the-fold row into view at 28px", () => {
			const { scrollEl, scrollToIndex } = mountList({
				rowCount: VIRTUALIZATION_THRESHOLD + 80,
				rowHeight: SIDEBAR_VIRTUAL_ROW_HEIGHT,
			});

			scrollToIndex(VIRTUALIZATION_THRESHOLD + 79);

			expect(scrollEl.scrollTop).toBe(
				(VIRTUALIZATION_THRESHOLD + 80) * SIDEBAR_VIRTUAL_ROW_HEIGHT - 400,
			);
		});

		it("still scrolls a below-the-fold row into view at 44px", () => {
			const { scrollEl, scrollToIndex } = mountList({
				rowCount: VIRTUALIZATION_THRESHOLD + 80,
				rowHeight: DOCUMENT_TABLE_ROW_HEIGHT,
			});

			scrollToIndex(VIRTUALIZATION_THRESHOLD + 79);

			expect(scrollEl.scrollTop).toBe(
				(VIRTUALIZATION_THRESHOLD + 80) * DOCUMENT_TABLE_ROW_HEIGHT - 400,
			);
		});
	});

	describe("callback identity", () => {
		// Consumers list `scrollToIndex` in effect dependency arrays so the scroll
		// fires on their own trigger only. A new identity per row count would
		// re-scroll on every filter, sort or folder expand.
		it("stays stable when the row count changes, across the threshold", () => {
			const list = mountList({
				rowCount: VIRTUALIZATION_THRESHOLD + 80,
				rowHeight: DOCUMENT_TABLE_ROW_HEIGHT,
			});
			const initial = list.currentScrollToIndex();

			list.renderWithRowCount(VIRTUALIZATION_THRESHOLD - 20);

			expect(list.currentScrollToIndex()).toBe(initial);
		});
	});

	describe("lists that fit their viewport", () => {
		it("leaves scroll alone when the content does not overflow", () => {
			const { scrollEl, scrollToIndex } = mountList({
				rowCount: 5,
				rowHeight: SIDEBAR_VIRTUAL_ROW_HEIGHT,
			});

			scrollToIndex(4);

			expect(scrollEl.scrollTop).toBe(0);
		});
	});
});
