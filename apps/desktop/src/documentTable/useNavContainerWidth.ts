import { type RefObject, useEffect, useState } from "react";

export type NavContainerWidths = {
	/** The split/outer container: drives R13's document-floor ceiling. */
	splitWidth: number;
	/** The list itself: drives the R9 density tier. */
	listWidth: number;
};

function measuredInlineSize(element: HTMLElement | null): number {
	if (!element) return 0;
	const rectWidth = element.getBoundingClientRect().width;
	if (Number.isFinite(rectWidth) && rectWidth > 0) return rectWidth;
	const clientWidth = element.clientWidth;
	return Number.isFinite(clientWidth) && clientWidth > 0 ? clientWidth : 0;
}

/**
 * Measures the two widths peek navigation is built out of, with one
 * ResizeObserver per container.
 *
 * On browse there is no split — both refs point at the same element and the
 * two values are equal by construction, so the density code needs no
 * `mode === "browse"` branch (EC-70). happy-dom has no ResizeObserver and no
 * layout: the hook then reports the synchronous measurement (0) and never
 * throws, which is also what the unit test asserts.
 */
export function useNavContainerWidth(
	splitRef: RefObject<HTMLElement | null>,
	listRef: RefObject<HTMLElement | null>,
): NavContainerWidths {
	const [splitWidth, setSplitWidth] = useState(() =>
		typeof window === "undefined" ? 0 : measuredInlineSize(splitRef.current),
	);
	const [listWidth, setListWidth] = useState(() =>
		typeof window === "undefined" ? 0 : measuredInlineSize(listRef.current),
	);

	useEffect(() => {
		setSplitWidth(measuredInlineSize(splitRef.current));
		setListWidth(measuredInlineSize(listRef.current));
		if (typeof ResizeObserver === "undefined") return;

		const splitObserver = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width;
			if (typeof width === "number" && Number.isFinite(width)) {
				setSplitWidth(width);
			}
		});
		const listObserver = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width;
			if (typeof width === "number" && Number.isFinite(width)) {
				setListWidth(width);
			}
		});
		if (splitRef.current) splitObserver.observe(splitRef.current);
		if (listRef.current) listObserver.observe(listRef.current);
		return () => {
			splitObserver.disconnect();
			listObserver.disconnect();
		};
	}, [splitRef, listRef]);

	return { splitWidth, listWidth };
}
