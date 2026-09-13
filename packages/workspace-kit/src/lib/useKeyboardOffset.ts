import { useEffect, useState } from "react";

/**
 * Soft-keyboard height for docking floating UI above it. Derived from
 * `visualViewport` (the only cross-browser signal — `keyboard-inset-height`
 * is Chrome-only): when the keyboard opens, the visual viewport shrinks and
 * `fixed bottom-0` elements would otherwise be covered. Returns 0 when
 * inactive or unsupported. Callers apply it as a `bottom` offset plus their
 * own safe-area padding.
 */
export function useKeyboardOffset(active: boolean): number {
	const [offset, setOffset] = useState(0);
	useEffect(() => {
		if (!active || typeof window === "undefined" || !window.visualViewport) {
			setOffset(0);
			return;
		}
		const viewport = window.visualViewport;
		const update = () => {
			setOffset(
				Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop),
			);
		};
		update();
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		return () => {
			viewport.removeEventListener("resize", update);
			viewport.removeEventListener("scroll", update);
		};
	}, [active]);
	return offset;
}
