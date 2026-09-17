import { DOCUMENT_TABLE_ROW_HEIGHT } from "./DocumentListRow";
import { navIndentRem } from "./navDensity";

export type DocumentGroupHeaderProps = {
	label: string;
	count: number;
	depth: number;
	expanded: boolean;
	onToggle: () => void;
	specId: string;
	groupId: string;
};

export function DocumentGroupHeader({
	label,
	count,
	depth,
	expanded,
	onToggle,
	specId,
	groupId,
}: DocumentGroupHeaderProps) {
	return (
		<div
			data-spec-id={specId}
			data-group-id={groupId}
			style={{
				blockSize: DOCUMENT_TABLE_ROW_HEIGHT,
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
