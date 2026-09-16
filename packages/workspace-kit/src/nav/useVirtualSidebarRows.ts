import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

export const SIDEBAR_VIRTUAL_ROW_HEIGHT = 28;

const DEFAULT_VIEWPORT_HEIGHT = SIDEBAR_VIRTUAL_ROW_HEIGHT * 24;
const DEFAULT_OVERSCAN_ROWS = 12;
const DEFAULT_VIRTUALIZATION_THRESHOLD = 120;

export type VirtualSidebarRow<T> = {
	index: number;
	row: T;
};

export function useVirtualSidebarRows<T>({
	overscanRows = DEFAULT_OVERSCAN_ROWS,
	rowHeight = SIDEBAR_VIRTUAL_ROW_HEIGHT,
	rows,
	scrollRef,
	virtualizationThreshold = DEFAULT_VIRTUALIZATION_THRESHOLD,
}: {
	overscanRows?: number;
	rowHeight?: number;
	rows: T[];
	scrollRef: RefObject<HTMLElement | null>;
	virtualizationThreshold?: number;
}) {
	const [scrollMetrics, setScrollMetrics] = useState({
		scrollTop: 0,
		viewportHeight: DEFAULT_VIEWPORT_HEIGHT,
	});
	const isVirtualized = rows.length > virtualizationThreshold;

	useEffect(() => {
		const scrollEl = scrollRef.current;
		if (!scrollEl || !isVirtualized) return;

		const updateMetrics = () => {
			setScrollMetrics({
				scrollTop: scrollEl.scrollTop,
				viewportHeight: scrollEl.clientHeight || DEFAULT_VIEWPORT_HEIGHT,
			});
		};
		updateMetrics();
		scrollEl.addEventListener("scroll", updateMetrics, { passive: true });

		const resizeObserver =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(updateMetrics);
		resizeObserver?.observe(scrollEl);

		return () => {
			scrollEl.removeEventListener("scroll", updateMetrics);
			resizeObserver?.disconnect();
		};
	}, [isVirtualized, scrollRef]);

	useEffect(() => {
		if (!isVirtualized) {
			setScrollMetrics({
				scrollTop: 0,
				viewportHeight: DEFAULT_VIEWPORT_HEIGHT,
			});
		}
	}, [isVirtualized]);

	/**
	 * Total height of the row model, read through a ref so `scrollToIndex` keeps
	 * a stable identity. Consumers list that callback in effect dependency
	 * arrays precisely so the scroll fires on *their* trigger (the open document,
	 * a key press) and nothing else; a new identity on every row-count change
	 * would re-fire it during a filter, sort or folder expand and yank the
	 * viewport away from a reading user.
	 */
	const contentHeightRef = useRef(0);
	contentHeightRef.current = rows.length * rowHeight;

	/**
	 * Brings a row into view, virtualized or not.
	 *
	 * `virtualizationThreshold` governs *rendering* — which rows exist in the
	 * DOM — and nothing else; it must never gate scrolling. A list overflows its
	 * viewport long before 120 rows (~17 rows in the 44px document table, ~24 in
	 * the 28px sidebar), so gating this on `isVirtualized` made "scroll the
	 * selected row into view" a silent no-op across the most common list sizes:
	 * opening a document from the command palette, a wiki link or Finder left
	 * the list looking like nothing was selected, because the highlighted row
	 * sat below the fold. The only precondition that matters is whether the
	 * content actually overflows the viewport.
	 *
	 * Row offsets are estimated as `index * rowHeight` (the same uniform-height
	 * assumption the virtual windowing above already makes), not measured.
	 */
	const scrollToIndex = useCallback(
		(index: number) => {
			const scrollEl = scrollRef.current;
			if (!scrollEl) return;
			if (contentHeightRef.current <= scrollEl.clientHeight) return;
			const rowTop = index * rowHeight;
			const rowBottom = rowTop + rowHeight;
			const viewportTop = scrollEl.scrollTop;
			const viewportBottom = viewportTop + scrollEl.clientHeight;
			if (rowTop < viewportTop) scrollEl.scrollTop = rowTop;
			else if (rowBottom > viewportBottom) {
				scrollEl.scrollTop = rowBottom - scrollEl.clientHeight;
			}
		},
		[rowHeight, scrollRef],
	);

	const virtualRows = useMemo(() => {
		if (!isVirtualized) {
			return {
				items: rows.map((row, index) => ({ index, row })),
				paddingBottom: 0,
				paddingTop: 0,
			};
		}

		const viewportHeight =
			scrollMetrics.viewportHeight || DEFAULT_VIEWPORT_HEIGHT;
		const firstVisibleIndex = Math.floor(scrollMetrics.scrollTop / rowHeight);
		const visibleCount = Math.ceil(viewportHeight / rowHeight);
		const startIndex = Math.max(0, firstVisibleIndex - overscanRows);
		const endIndex = Math.min(
			rows.length,
			firstVisibleIndex + visibleCount + overscanRows,
		);
		return {
			items: rows
				.slice(startIndex, endIndex)
				.map((row, offset) => ({ index: startIndex + offset, row })),
			paddingBottom: Math.max(0, rows.length - endIndex) * rowHeight,
			paddingTop: startIndex * rowHeight,
		};
	}, [isVirtualized, overscanRows, rowHeight, rows, scrollMetrics]);

	return {
		isVirtualized,
		scrollToIndex,
		...virtualRows,
	};
}
