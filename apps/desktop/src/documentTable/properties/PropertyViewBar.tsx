import { useState } from "react";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import { workspacePathStore } from "../../store/state";
import {
	addPropertyFilter,
	removePropertyFilter,
	replacePropertyFilter,
	saveCurrentViewAs,
	setPropertyGroupBy,
} from "../documentTableStore";
import {
	type DocumentTableView,
	folderMatchesQuery,
} from "../documentTableView";
import { validateSavedViewName } from "../documentViewsFileStore";
import { SavedViewNameInput } from "../SavedViewControls";
import {
	describeGroupBy,
	describePropertyFilter,
	type FolderFilter,
	isFolderFilter,
} from "./documentViews";
import type { PropertyField } from "./propertyFields";
import { type PropertyScanState, scanStatusText } from "./propertyScanStore";

const CHIP_CLASS = "mdly-chip max-w-64";
const CHIP_REMOVE_CLASS =
	"inline-flex size-4 shrink-0 items-center justify-center rounded-full text-current outline-hidden opacity-70 hover:bg-chip-foreground/15 hover:opacity-100 focus-visible:ring-1 focus-visible:ring-ring";
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
					if (!id) {
						return { ok: false, message: "The view couldn't be saved" };
					}
					setNaming(false);
					return valid;
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
	folders = [],
}: {
	view: DocumentTableView;
	fields: readonly PropertyField[];
	scan: PropertyScanState;
	/** Workspace folders for the "+ Folder" picker (PO 2026-11-02). */
	folders?: readonly string[];
}) {
	const status = scanStatusText(scan);
	return (
		<div className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 [padding-block-end:0.5rem]">
			{view.propertyFilters.map((filter) => {
				const label = describePropertyFilter(filter, fields);
				return (
					<span key={label} className={CHIP_CLASS}>
						{isFolderFilter(filter) ? (
							<FolderPicker
								folders={folders}
								current={filter.path}
								triggerClassName="truncate outline-hidden hover:underline focus-visible:underline"
								triggerLabel={label}
								onPick={(path) =>
									replacePropertyFilter(filter, { kind: "folder", path })
								}
							/>
						) : (
							<span className="truncate">{label}</span>
						)}
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
			<FolderPicker
				folders={folders}
				current={null}
				triggerClassName={cn(
					TAB_CLASS,
					"h-6 text-[11px] text-muted-foreground hover:bg-accent",
				)}
				triggerLabel="+ Folder"
				onPick={(path) => addPropertyFilter({ kind: "folder", path })}
			/>
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

/**
 * "+ Folder" / folder-chip picker: a searchable list of workspace folders.
 * The only way to enter a folder filter (no typed syntax, PO 2026-11-02).
 */
function FolderPicker({
	folders,
	current,
	triggerClassName,
	triggerLabel,
	onPick,
}: {
	folders: readonly string[];
	current: FolderFilter["path"] | null;
	triggerClassName: string;
	triggerLabel: string;
	onPick: (path: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const shown = query.trim()
		? folders.filter((folder) => folderMatchesQuery(folder, query))
		: folders;
	const pick = (folder: string) => {
		setOpen(false);
		if (folder !== current) onPick(folder);
	};
	// Portalled popover: an inline absolute panel was painted under the table.
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				if (next) setQuery("");
				setOpen(next);
			}}
		>
			<PopoverTrigger className={triggerClassName} aria-haspopup="listbox">
				{triggerLabel}
			</PopoverTrigger>
			<PopoverContent
				align="start"
				aria-label="Choose a folder"
				className="w-64 gap-1 p-1.5"
			>
				<input
					// biome-ignore lint/a11y/noAutofocus: picker opened by an explicit click
					autoFocus
					aria-label="Search folders"
					placeholder="Search folders…"
					className="h-6 rounded border border-border bg-transparent px-1.5 outline-hidden"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<div role="listbox" className="flex max-h-64 flex-col overflow-y-auto">
					{shown.length === 0 ? (
						<span className="px-1.5 py-1 text-muted-foreground">
							No folders
						</span>
					) : (
						shown.map((folder) => (
							<div
								key={folder}
								role="option"
								tabIndex={0}
								aria-selected={folder === current}
								className="shrink-0 cursor-default truncate rounded px-1.5 py-1 outline-hidden hover:bg-accent focus-visible:bg-accent"
								onClick={() => pick(folder)}
								onKeyDown={(event) => {
									if (event.key === "Enter") pick(folder);
								}}
							>
								{folder}
							</div>
						))
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
