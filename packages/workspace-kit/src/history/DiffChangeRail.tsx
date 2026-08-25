import type { ChangeGroup } from "@mdly/doc-history";
import { type RefObject, useEffect, useMemo, useState } from "react";
import "./DiffChangeRail.css";

const ACTIVE_OFFSET = 40;

function groupTextLength(group: ChangeGroup): number {
	return group.kind === "unchanged"
		? group.value.length
		: group.oldText.length + group.newText.length;
}

/**
 * The diff-view analog of `TableOfContents.tsx`'s heading rail: one dash per
 * changed region, positioned as a fraction of the diff's total rendered text
 * length (there's no ProseMirror doc here to measure node positions
 * against, so character length stands in for `pos/docSize`). Renders
 * nothing when there are no changed regions to mark.
 */
export function DiffChangeRail({
	groups,
	containerRef,
}: {
	groups: ChangeGroup[];
	containerRef: RefObject<HTMLElement | null>;
}) {
	const [activeId, setActiveId] = useState<string | null>(null);

	const marks = useMemo(() => {
		const total = groups.reduce(
			(sum, group) => sum + groupTextLength(group),
			0,
		);
		if (total === 0) return [];
		let offset = 0;
		const result: Array<{ id: string; progress: number }> = [];
		for (const group of groups) {
			if (group.kind === "changed") {
				result.push({ id: group.id, progress: offset / total });
			}
			offset += groupTextLength(group);
		}
		return result;
	}, [groups]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || marks.length === 0) {
			setActiveId(null);
			return;
		}

		const updateActive = () => {
			const containerTop = container.getBoundingClientRect().top;
			let active: string | null = marks[0]?.id ?? null;
			for (const mark of marks) {
				const el = container.querySelector<HTMLElement>(
					`[data-region-id="${mark.id}"]`,
				);
				if (!el) continue;
				if (el.getBoundingClientRect().top - containerTop <= ACTIVE_OFFSET) {
					active = mark.id;
				}
			}
			setActiveId(active);
		};

		updateActive();
		container.addEventListener("scroll", updateActive, { passive: true });
		return () => container.removeEventListener("scroll", updateActive);
	}, [marks, containerRef]);

	if (marks.length === 0) return null;

	const scrollToRegion = (id: string) => {
		containerRef.current
			?.querySelector(`[data-region-id="${id}"]`)
			?.scrollIntoView({ block: "start", behavior: "smooth" });
	};

	return (
		<div className="diffChangeRail" aria-hidden="true">
			{marks.map((mark) => (
				<button
					key={mark.id}
					type="button"
					className="diffChangeRailDash"
					data-active={mark.id === activeId}
					style={{ insetBlockStart: `${mark.progress * 100}%` }}
					aria-label="Jump to this change"
					onClick={() => scrollToRegion(mark.id)}
				/>
			))}
		</div>
	);
}
