import { Button } from "@hubble.md/ui";

/** Empty result while search text is active: names it and offers a way out. */
export function FilterEmptyMessage({
	filter,
	onClearFilter,
	className,
}: {
	filter: string;
	onClearFilter: () => void;
	className: string;
}) {
	return (
		<div className="flex flex-col items-start gap-2">
			<p className={className}>No documents match the search “{filter}”.</p>
			<Button size="sm" variant="outline" onClick={onClearFilter}>
				Clear search
			</Button>
		</div>
	);
}
