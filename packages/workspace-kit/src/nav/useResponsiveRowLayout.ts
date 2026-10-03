import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * "list"  -- compact rows: title with its meta inline.
 * "table" -- the same meta split into aligned columns.
 */
export type SidebarRowLayout = "list" | "table";

export const DEFAULT_TABLE_BREAKPOINT = 420;

/*
 * Timings measured frame-by-frame (60fps) from the reference recording:
 * - Cells glide on a critically damped spring (starts from rest, no
 *   overshoot), settling in ~10 frames (~170ms). All cells start together --
 *   no stagger between rows or columns.
 * - Column decorations (folder-row icons) cross-fade in ~100ms; they lag the
 *   glide by ~2 frames on the way in and fade out (not vanish) on the way out.
 */
const SPRING_OMEGA = 39; // rad/s -> 99% settled at ~170ms
export const SPRING_DURATION_MS = 170;
const FADE_DURATION_MS = 100;
const FADE_IN_DELAY_MS = 33;
const FLIP_SELECTOR = "[data-flip-id]";
const ENTER_SELECTOR = "[data-flip-enter]";

type Snapshot = {
	rects: Map<string, DOMRect>;
	/** Decorations that disappear in the new layout, cloned to fade out. */
	leaving: { node: HTMLElement; rect: DOMRect }[];
};

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
 * Animations API on a critically damped spring. Elements without a previous
 * position, and `[data-flip-enter]` decorations, fade in; decorations that
 * leave fade out as ghosts. Skipped entirely under
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
	const rects = new Map<string, DOMRect>();
	for (const node of root.querySelectorAll<HTMLElement>(FLIP_SELECTOR)) {
		const id = node.dataset.flipId;
		if (id) rects.set(id, node.getBoundingClientRect());
	}
	const leaving = Array.from(
		root.querySelectorAll<HTMLElement>(ENTER_SELECTOR),
		(node) => ({
			node: node.cloneNode(true) as HTMLElement,
			rect: node.getBoundingClientRect(),
		}),
	);
	return { rects, leaving };
}

/**
 * Keyframe offsets for a critically damped spring from rest:
 * progress(t) = 1 - (1 + wt) e^(-wt). Sampled per frame so WAAPI plays it
 * with linear interpolation between samples.
 */
export function springProgressSamples(
	durationMs: number = SPRING_DURATION_MS,
	omega: number = SPRING_OMEGA,
): number[] {
	const frames = Math.max(2, Math.round(durationMs / (1000 / 60)));
	const samples: number[] = [];
	for (let i = 0; i <= frames; i++) {
		const wt = (omega * (i / frames) * durationMs) / 1000;
		samples.push(i === frames ? 1 : 1 - (1 + wt) * Math.exp(-wt));
	}
	return samples;
}

function playFlip(root: HTMLElement, before: Snapshot) {
	if (typeof root.animate !== "function") return;
	const spring = springProgressSamples();
	const glide = { duration: SPRING_DURATION_MS, easing: "linear" };
	const fadeIn = {
		duration: FADE_DURATION_MS,
		delay: FADE_IN_DELAY_MS,
		easing: "ease-out",
		fill: "backwards" as const,
	};
	for (const node of root.querySelectorAll<HTMLElement>(FLIP_SELECTOR)) {
		const prev = before.rects.get(node.dataset.flipId ?? "");
		if (!prev) {
			node.animate([{ opacity: 0 }, { opacity: 1 }], fadeIn);
			continue;
		}
		const next = node.getBoundingClientRect();
		const dx = prev.left - next.left;
		const dy = prev.top - next.top;
		if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
		node.animate(
			spring.map((p) => ({
				transform: `translate(${dx * (1 - p)}px, ${dy * (1 - p)}px)`,
			})),
			glide,
		);
	}
	const entering = root.querySelectorAll<HTMLElement>(ENTER_SELECTOR);
	for (const node of entering) {
		node.animate([{ opacity: 0 }, { opacity: 1 }], fadeIn);
	}
	// Decorations gone from the new layout fade out as fixed-position ghosts.
	if (entering.length > 0) return;
	const doc = root.ownerDocument;
	for (const { node, rect } of before.leaving) {
		Object.assign(node.style, {
			position: "fixed",
			left: `${rect.left}px`,
			top: `${rect.top}px`,
			width: `${rect.width}px`,
			height: `${rect.height}px`,
			margin: "0",
			pointerEvents: "none",
		});
		node.setAttribute("aria-hidden", "true");
		node.removeAttribute("data-flip-enter");
		doc.body.append(node);
		const anim = node.animate([{ opacity: 1 }, { opacity: 0 }], {
			duration: FADE_DURATION_MS,
			easing: "ease-out",
			fill: "forwards",
		});
		anim.onfinish = () => node.remove();
		anim.oncancel = () => node.remove();
	}
}

function prefersReducedMotion() {
	return (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}
