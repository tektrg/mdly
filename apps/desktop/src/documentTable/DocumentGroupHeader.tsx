import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { DOCUMENT_TABLE_ROW_HEIGHT } from "./DocumentListRow";
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
			}}
		>
			<button type="button" aria-expanded={expanded} onClick={onToggle}>
				{label}
				{count}
			</button>
		</div>
	);
}
