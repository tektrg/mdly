import { useState } from "react";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import { cn } from "../../lib/utils";
import { workspacePathStore } from "../../store/state";
import {
	removePropertyFilter,
	saveCurrentViewAs,
	setPropertyGroupBy,
} from "../documentTableStore";
import type { DocumentTableView } from "../documentTableView";
import { validateSavedViewName } from "../documentViewsFileStore";
import { SavedViewNameInput } from "../SavedViewControls";
import { describeGroupBy, describePropertyFilter } from "./documentViews";
import type { PropertyField } from "./propertyFields";
import { type PropertyScanState, scanStatusText } from "./propertyScanStore";

const CHIP_CLASS =
	"inline-flex h-6 max-w-64 items-center gap-1 rounded-full border border-border bg-muted/40 ps-2.5 pe-1 text-[11px] text-foreground";
const CHIP_REMOVE_CLASS =
	"inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring";
const TAB_CLASS =
	"inline-flex h-7 max-w-48 items-center rounded-md px-2 text-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Saved views R6: the property bar's only saved-view control. Snapshots the
 * current view under a name; the new view appears (selected) as an icon in
 * the view switcher row.
 */
export function SaveViewButton({ canSave }: { canSave: boolean }) {
	const [naming, setNaming] = useState(false);
	if (naming) {
		return (
			<SavedViewNameInput
				initialName=""
				onCommit={(name) => {
					const workspacePath = workspacePathStore.get() ?? null;
					const valid = validateSavedViewName(workspacePath, name);
					if (!valid.ok) return valid;
					const id = saveCurrentViewAs(name);
					if (id) setNaming(false);
					return id ? valid : { ok: false, reason: "empty" };
				}}
				onCancel={() => setNaming(false)}
			/>
		);
	}
	if (!canSave) return null;
	return (
		<button
			type="button"
			className={cn(TAB_CLASS, "text-xs text-muted-foreground hover:bg-accent")}
			onClick={() => setNaming(true)}
		>
			Save view…
		</button>
	);
}

/**
 * The view's filter chips, its grouping, and the scan status — always visible
 * (decision E: a filter is never silent), each chip deletable in one click.
 */
export function PropertyViewBar({
	view,
	fields,
	scan,
}: {
	view: DocumentTableView;
	fields: readonly PropertyField[];
	scan: PropertyScanState;
}) {
	const status = scanStatusText(scan);
	const hasChips =
		view.propertyFilters.length > 0 || view.propertyGroupBy !== null;
	if (!hasChips && !status) return null;
	return (
		<div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 [padding-block-end:0.5rem]">
			{view.propertyFilters.map((filter) => {
				const label = describePropertyFilter(filter, fields);
				return (
					<span key={label} className={CHIP_CLASS}>
						<span className="truncate">{label}</span>
						<button
							type="button"
							className={CHIP_REMOVE_CLASS}
							aria-label={`Remove filter: ${label}`}
							title="Remove filter"
							onClick={() => removePropertyFilter(filter)}
						>
							<MingcuteCloseLine aria-hidden="true" className="size-3" />
						</button>
					</span>
				);
			})}
			{view.propertyGroupBy ? (
				<span className={cn(CHIP_CLASS, "bg-transparent")}>
					<span className="truncate">
						{describeGroupBy(view.propertyGroupBy, fields)}
					</span>
					<button
						type="button"
						className={CHIP_REMOVE_CLASS}
						aria-label="Remove grouping"
						title="Remove grouping"
						onClick={() => setPropertyGroupBy(null)}
					>
						<MingcuteCloseLine aria-hidden="true" className="size-3" />
					</button>
				</span>
			) : null}
			{status ? (
				<span
					role="status"
					className={cn(
						"text-[11px]",
						scan.status === "failed"
							? "text-destructive"
							: "text-muted-foreground/70",
					)}
					title={
						scan.invalidPaths.length > 0
							? scan.invalidPaths.slice(0, 10).join("\n")
							: undefined
					}
				>
					{status}
				</span>
			) : null}
		</div>
	);
}
