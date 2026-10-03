import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * "list"  -- compact rows: title with its meta inline.
 * "table" -- the same meta split into aligned columns.
 */
export type SidebarRowLayout = "list" | "table";

export const DEFAULT_TABLE_BREAKPOINT = 420;

const FLIP_DURATION_MS = 220;
const FLIP_EASING = "cubic-bezier(0.2, 0, 0, 1)";
const FLIP_SELECTOR = "[data-flip-id]";
const ENTER_SELECTOR = "[data-flip-enter]";

type Snapshot = Map<string, DOMRect>;

/**
 * Picks the row layout from the CONTAINER's own width (not the window's), so
 * it follows whatever resizes the host panel -- a kit drag edge or a host CSS
 * var such as `--app-sidebar-width`.
 *
 * Cheap during a drag: the ResizeObserver callback only compares a number and
 * sets state when the breakpoint is actually crossed, so React re-renders the
 * rows once per crossing, never per frame. On a crossing it snapshots every
 * `[data-flip-id]` element, and after the new layout commits it plays a FLIP
 * (First-Last-Invert-Play) glide from old to new position with the Web
 * Animations API. Elements without a previous position, and
 * `[data-flip-enter]` decorations, fade in instead. Skipped entirely under
 * `prefers-reduced-motion: reduce`.
 */
export function useResponsiveRowLayout(
	containerRef: RefObject<HTMLElement | null>,
	breakpoint: number = DEFAULT_TABLE_BREAKPOINT,
): SidebarRowLayout {
	const [layout, setLayout] = useState<SidebarRowLayout>("list");
	const layoutRef = useRef(layout);
	layoutRef.current = layout;
	const snapshotRef = useRef<Snapshot | null>(null);

	useLayoutEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const apply = (width: number, animate: boolean) => {
			// A zero width means hidden/unmounted pane -- keep the last layout.
			if (width <= 0) return;
			const next: SidebarRowLayout = width >= breakpoint ? "table" : "list";
			if (next === layoutRef.current) return;
			snapshotRef.current = animate ? snapshotFlipRects(el) : null;
			layoutRef.current = next;
			setLayout(next);
		};
		apply(el.getBoundingClientRect().width, false);
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			const entry = entries[entries.length - 1];
			if (entry) apply(entry.contentRect.width, true);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [breakpoint, containerRef]);

	useLayoutEffect(() => {
		const before = snapshotRef.current;
		snapshotRef.current = null;
		const el = containerRef.current;
		if (!before || !el || prefersReducedMotion()) return;
		playFlip(el, before);
	}, [layout, containerRef]);

	// Drop a stale snapshot if the component unmounts mid-crossing.
	useEffect(() => () => void (snapshotRef.current = null), []);

	return layout;
}

function snapshotFlipRects(root: HTMLElement): Snapshot {
	const snapshot: Snapshot = new Map();
	for (const node of root.querySelectorAll<HTMLElement>(FLIP_SELECTOR)) {
		const id = node.dataset.flipId;
		if (id) snapshot.set(id, node.getBoundingClientRect());
	}
	return snapshot;
}

function playFlip(root: HTMLElement, before: Snapshot) {
	const timing = { duration: FLIP_DURATION_MS, easing: FLIP_EASING };
	for (const node of root.querySelectorAll<HTMLElement>(FLIP_SELECTOR)) {
		if (typeof node.animate !== "function") return;
		const prev = before.get(node.dataset.flipId ?? "");
		if (!prev) {
			node.animate([{ opacity: 0 }, { opacity: 1 }], timing);
			continue;
		}
		const next = node.getBoundingClientRect();
		const dx = prev.left - next.left;
		const dy = prev.top - next.top;
		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
		node.animate(
			[
				{ transform: `translate(${dx}px, ${dy}px)` },
				{ transform: "translate(0, 0)" },
			],
			timing,
		);
	}
	for (const node of root.querySelectorAll<HTMLElement>(ENTER_SELECTOR)) {
		if (typeof node.animate !== "function") return;
		node.animate([{ opacity: 0 }, { opacity: 1 }], timing);
	}
}

function prefersReducedMotion() {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}
