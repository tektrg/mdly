import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
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

	const scrollToIndex = useCallback(
		(index: number) => {
			if (!isVirtualized) return;
			const scrollEl = scrollRef.current;
			if (!scrollEl) return;
			const rowTop = index * rowHeight;
			const rowBottom = rowTop + rowHeight;
			const viewportTop = scrollEl.scrollTop;
			const viewportBottom = viewportTop + scrollEl.clientHeight;
			if (rowTop < viewportTop) scrollEl.scrollTop = rowTop;
			else if (rowBottom > viewportBottom) {
				scrollEl.scrollTop = rowBottom - scrollEl.clientHeight;
			}
		},
		[isVirtualized, rowHeight, scrollRef],
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
