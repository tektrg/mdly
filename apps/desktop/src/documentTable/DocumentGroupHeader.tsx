import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import MingcuteRightLine from "~icons/mingcute/right-line";
import { cn } from "../lib/utils";
import { DOCUMENT_TABLE_ROW_HEIGHT } from "./DocumentListRow";
import { MiddleTruncatedPath } from "./MiddleTruncatedPath";
import { navIndentRem } from "./navDensity";

export type DocumentGroupHeaderProps = {
	label: string;
	count: number;
	depth: number;
	expanded: boolean;
	onToggle: () => void;
	specId: string | null;
	groupId: string;
	/** Absolute virtualizer index — present when rendered inside a row list. */
	index?: number;
	/** Grid row index (header-offset); present alongside `index`. */
	ariaRowIndex?: number;
	/** Roving tabindex value from the list; absent when standalone. */
	tabIndex?: number;
	onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
	/**
	 * The list's fixed row height. Defaults to the table row height, which is
	 * what the header already matched — the virtualizer's windowing math only
	 * holds when headers and documents share one height per list.
	 */
	rowHeight?: number;
};

export function DocumentGroupHeader({
	label,
	count,
	depth,
	expanded,
	onToggle,
	specId,
	groupId,
	index,
	ariaRowIndex,
	tabIndex,
	onKeyDown,
	rowHeight = DOCUMENT_TABLE_ROW_HEIGHT,
}: DocumentGroupHeaderProps) {
	// Standalone (no index) renders no row semantics at all — the grid
	// attributes only exist inside a row list, where the role makes them valid.
	const rowProps =
		index === undefined
			? {}
			: {
					role: "row",
					"aria-rowindex": ariaRowIndex,
					"data-document-row-index": index,
					tabIndex,
					onKeyDown,
				};
	return (
		<div
			{...rowProps}
			data-spec-id={specId}
			data-group-id={groupId}
			style={{
				blockSize: rowHeight,
				paddingInlineStart: `${navIndentRem(depth)}rem`,
				...(index === undefined
					? null
					: { transform: `translateY(${index * rowHeight}px)` }),
			}}
			className={cn(
				"flex items-center rounded-[var(--radius-row)] outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
				// Mirror DocumentListRow's virtual positioning: the row list's
				// inner container is `relative` with a fixed block size and every
				// row is absolutely placed at `index * rowHeight`. Without this
				// the headers stay in normal flow while documents overlay them.
				index !== undefined &&
					"absolute start-1 end-1 [inset-block-start:0] transition-[transform,background-color,color] duration-180 ease-snappy motion-reduce:transition-none [[data-resizing]_&]:transition-none",
			)}
		>
			<button
				type="button"
				aria-expanded={expanded}
				onClick={onToggle}
				title={label}
				tabIndex={-1}
				className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-row)] text-start text-sidebar-foreground outline-hidden transition-[background-color,color] duration-150 ease-snappy hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none [padding-inline:var(--row-pad-inline)] [padding-block:var(--row-pad-block)]"
			>
				<span
					aria-hidden="true"
					className="inline-flex size-3 shrink-0 items-center justify-center text-muted-foreground"
				>
					<MingcuteRightLine
						className={cn(
							"size-3 transition-transform duration-150 ease-out",
							expanded && "rotate-90",
						)}
					/>
				</span>
				<MiddleTruncatedPath
					path={label}
					className="min-w-0 flex-1 truncate text-[length:var(--font-size-sidebar)] font-medium"
				/>
				<span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
					{count}
				</span>
			</button>
		</div>
	);
}
