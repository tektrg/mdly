import { Button } from "@hubble.md/ui";

/**
 * A9's tag-scan states in the narrow list's own visual shape
 * (`DocumentNarrowList.tsx`): a muted sentence while scanning, destructive
 * text plus a "Try again" button on failure. Tag-specific copy, same shape.
 */
export function TagScanStateView({
	status,
	onRetry,
}: {
	status: "scanning" | "failed";
	onRetry: () => void;
}) {
	if (status === "scanning") {
		return (
			<p
				data-tag-scan-state="scanning"
				className="m-0 text-[length:var(--font-size-sidebar)] text-muted-foreground"
			>
				Reading tags…
			</p>
		);
	}

	return (
		<div
			data-tag-scan-state="failed"
			className="flex flex-col items-start gap-2"
		>
			<p className="m-0 text-[length:var(--font-size-sidebar)] text-destructive">
				Tags could not be read.
			</p>
			<Button size="sm" variant="outline" onClick={onRetry}>
				Try again
			</Button>
		</div>
	);
}
