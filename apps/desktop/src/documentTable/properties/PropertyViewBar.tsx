import { useState } from "react";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import MingcuteMore2Line from "~icons/mingcute/more-2-line";
import { cn } from "../../lib/utils";
import {
	deleteSavedView,
	removePropertyFilter,
	renameSavedView,
	saveCurrentViewAs,
	selectSavedView,
	setPropertyGroupBy,
} from "../documentTableStore";
import type { DocumentTableView } from "../documentTableView";
import {
	describeGroupBy,
	describePropertyFilter,
	MAX_SAVED_VIEW_NAME_LENGTH,
	type SavedDocumentView,
} from "./documentViews";
import { PropertyMenu, PropertyMenuItem } from "./PropertyMenu";
import type { PropertyField } from "./propertyFields";
import { type PropertyScanState, scanStatusText } from "./propertyScanStore";

const CHIP_CLASS =
	"inline-flex h-6 max-w-64 items-center gap-1 rounded-full border border-border bg-muted/40 ps-2.5 pe-1 text-[11px] text-foreground";
const CHIP_REMOVE_CLASS =
	"inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring";
const TAB_CLASS =
	"inline-flex h-7 max-w-48 items-center rounded-md px-2 text-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring";

/** Inline name box for "Save view" and "Rename". Enter commits, Escape cancels. */
function ViewNameInput({
	initialName,
	onCommit,
	onCancel,
}: {
	initialName: string;
	onCommit: (name: string) => void;
	onCancel: () => void;
}) {
	const [name, setName] = useState(initialName);
	return (
		<input
			// biome-ignore lint/a11y/noAutofocus: opened by an explicit click, the user is about to type
			autoFocus
			aria-label="View name"
			value={name}
			maxLength={MAX_SAVED_VIEW_NAME_LENGTH}
			placeholder="View name"
			onChange={(event) => setName(event.target.value)}
			onBlur={onCancel}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					if (name.trim()) onCommit(name);
					else onCancel();
				} else if (event.key === "Escape") {
					event.preventDefault();
					onCancel();
				}
			}}
			className="h-7 w-40 rounded-md border border-input bg-background px-2 text-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
		/>
	);
}

/**
 * Phase 3: "All documents" plus the workspace's saved views, as tabs in the
 * table header. Edits made while a saved view is shown are saved into it.
 */
export function SavedViewTabs({
	savedViews,
	activeView,
	canSave,
}: {
	savedViews: readonly SavedDocumentView[];
	activeView: SavedDocumentView | null;
	/** "Save view" shows only when the unsaved view has something worth keeping. */
	canSave: boolean;
}) {
	const [naming, setNaming] = useState<"new" | string | null>(null);
	return (
		<nav
			aria-label="Saved views"
			className="flex min-w-0 flex-wrap items-center gap-1"
		>
			<button
				type="button"
				aria-current={activeView === null ? "page" : undefined}
				className={cn(
					TAB_CLASS,
					activeView === null
						? "font-medium text-foreground"
						: "text-muted-foreground hover:bg-accent",
				)}
				onClick={() => selectSavedView(null)}
			>
				All documents
			</button>
			{savedViews.map((view) =>
				naming === view.id ? (
					<ViewNameInput
						key={view.id}
						initialName={view.name}
						onCommit={(name) => {
							renameSavedView(view.id, name);
							setNaming(null);
						}}
						onCancel={() => setNaming(null)}
					/>
				) : (
					<span key={view.id} className="group inline-flex items-center">
						<button
							type="button"
							aria-current={activeView?.id === view.id ? "page" : undefined}
							className={cn(
								TAB_CLASS,
								"truncate",
								activeView?.id === view.id
									? "bg-accent font-medium text-foreground"
									: "text-muted-foreground hover:bg-accent",
							)}
							onClick={() => selectSavedView(view.id)}
						>
							<span className="truncate">{view.name}</span>
						</button>
						{activeView?.id === view.id ? (
							<PropertyMenu
								trigger={
									<MingcuteMore2Line aria-hidden="true" className="size-3.5" />
								}
								triggerClassName="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
								triggerLabel={`${view.name} options`}
								align="start"
							>
								<PropertyMenuItem onClick={() => setNaming(view.id)}>
									Rename view
								</PropertyMenuItem>
								<PropertyMenuItem onClick={() => deleteSavedView(view.id)}>
									Delete view
								</PropertyMenuItem>
							</PropertyMenu>
						) : null}
					</span>
				),
			)}
			{naming === "new" ? (
				<ViewNameInput
					initialName=""
					onCommit={(name) => {
						saveCurrentViewAs(name);
						setNaming(null);
					}}
					onCancel={() => setNaming(null)}
				/>
			) : canSave && activeView === null ? (
				<button
					type="button"
					className={cn(
						TAB_CLASS,
						"text-xs text-muted-foreground hover:bg-accent",
					)}
					onClick={() => setNaming("new")}
				>
					Save view…
				</button>
			) : null}
		</nav>
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
