import { useLayoutEffect, useRef, useState } from "react";

const ELLIPSIS = "…";

/**
 * Candidate labels for `path`, longest first: the full path, then the path
 * with ever more middle segments folded into one "…" — always keeping the
 * first and last segment and every slash boundary, e.g.
 * `skills/project/memory` → `skills/…/memory`.
 */
export function middleTruncationCandidates(path: string): string[] {
	const segments = path.split("/");
	if (segments.length < 3) return [path];
	const first = segments[0];
	const last = segments[segments.length - 1];
	const middle = segments.slice(1, -1);
	const candidates = [path];
	// Drop middle segments from the centre outward, keeping as many as fit.
	for (let keep = middle.length - 1; keep >= 0; keep--) {
		const head = middle.slice(0, Math.ceil(keep / 2));
		const tail = middle.slice(middle.length - Math.floor(keep / 2));
		candidates.push([first, ...head, ELLIPSIS, ...tail, last].join("/"));
	}
	return candidates;
}

/**
 * A folder path that, when its cell is too narrow, collapses middle segments
 * to "…" (keeping slashes) before falling back to an end ellipsis.
 */
export function MiddleTruncatedPath({
	path,
	className,
}: {
	path: string;
	className?: string;
}) {
	const ref = useRef<HTMLSpanElement>(null);
	const [label, setLabel] = useState(path);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const candidates = middleTruncationCandidates(path);
		const fit = () => {
			for (const candidate of candidates) {
				el.textContent = candidate;
				if (el.scrollWidth <= el.clientWidth) break;
			}
			setLabel(el.textContent ?? path);
		};
		fit();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(fit);
		observer.observe(el);
		// An inline-block label sizes to its text, so watch the container too:
		// widening it must let a shortened label grow back.
		if (el.parentElement) observer.observe(el.parentElement);
		return () => observer.disconnect();
	}, [path]);

	return (
		<span ref={ref} className={className} title={path}>
			{label}
		</span>
	);
}
