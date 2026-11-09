import { type ReactNode, useState } from "react";
import MingcuteAddLine from "~icons/mingcute/add-line";
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

/** Pill chip, toolbar tokens (SpeechToDo design system: chips are pills). */
const CHIP_CLASS =
	"inline-flex h-6 max-w-64 min-w-0 items-center gap-1 rounded-full bg-mdly-control ps-2.5 pe-1 text-[11px] text-mdly-strong";
const CHIP_REMOVE_CLASS =
	"inline-flex size-4 shrink-0 items-center justify-center rounded-full text-current outline-hidden opacity-70 hover:bg-chip-foreground/15 hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-mdly-ink/20";
const GHOST_CHIP_CLASS =
	"inline-flex h-6 shrink-0 items-center rounded-full bg-mdly-control/60 px-2.5 text-[11px] text-muted-foreground outline-hidden transition-colors hover:bg-mdly-control hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-mdly-ink/20";

/**
 * Saved views R6, in the tab row: "+" always snapshots the current view under
 * a new name; "Save" (gold) is the same action, shown only while the built-in
 * view carries unsaved changes. The new view becomes the selected tab.
 */
export function SaveViewButton({
	variant,
	visible = true,
}: {
	variant: "add" | "save";
	visible?: boolean;
}) {
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
	if (!visible) return null;
	if (variant === "add") {
		return (
			<button
				type="button"
				data-save-view="add"
				aria-label="Save as new view"
				title="Save as new view"
				className="mdly-ink-button inline-flex size-6 shrink-0 items-center justify-center"
				onClick={() => setNaming(true)}
			>
				<MingcuteAddLine aria-hidden="true" className="size-3.5" />
			</button>
		);
	}
	return (
		<button
			type="button"
			data-save-view="save"
			title="Save these changes as a view"
			className="mdly-ink-button inline-flex h-6 shrink-0 items-center px-3"
			onClick={() => setNaming(true)}
		>
			Save
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
	leading,
	trailing,
}: {
	view: DocumentTableView;
	fields: readonly PropertyField[];
	scan: PropertyScanState;
	/** Workspace folders for the "+ Filter" picker (PO 2026-11-02). */
	folders?: readonly string[];
	/** Toolbar row content before the chips (the layout switcher). */
	leading?: ReactNode;
	/** Toolbar row content at the far end (search, overflow menu). */
	trailing?: ReactNode;
}) {
	const status = scanStatusText(scan);
	const invalidCount = scan.invalidPaths.length;
	// Only the settled "N files have unreadable front matter" state collapses
	// to a badge; progress and failure keep their full sentence.
	const asBadge =
		status !== null &&
		scan.status !== "scanning" &&
		scan.status !== "failed" &&
		invalidCount > 0;
	return (
		<div
			data-document-toolbar
			className="flex shrink-0 flex-wrap items-center gap-1.5 px-3 [padding-block:0.375rem]"
		>
			{leading}
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
				triggerClassName={GHOST_CHIP_CLASS}
				triggerLabel="+ Filter"
				triggerTitle="Filter by folder"
				onPick={(path) => addPropertyFilter({ kind: "folder", path })}
			/>
			<span aria-hidden="true" className="min-w-2 flex-1" />
			{status && asBadge ? (
				<span
					role="status"
					data-scan-badge
					className="inline-flex h-6 shrink-0 cursor-default items-center gap-1 rounded-full bg-mdly-control px-2 text-[11px] font-medium tabular-nums text-mdly-strong"
					title={[status, ...scan.invalidPaths.slice(0, 10)].join("\n")}
				>
					<span aria-hidden="true">⚠ {invalidCount.toLocaleString()}</span>
					<span className="sr-only">{status}</span>
				</span>
			) : status ? (
				<span
					role="status"
					className={cn(
						"text-[11px]",
						scan.status === "failed"
							? "text-destructive"
							: "text-muted-foreground/70",
					)}
					title={
						invalidCount > 0
							? scan.invalidPaths.slice(0, 10).join("\n")
							: undefined
					}
				>
					{status}
				</span>
			) : null}
			{trailing}
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
	triggerTitle,
	onPick,
}: {
	folders: readonly string[];
	current: FolderFilter["path"] | null;
	triggerClassName: string;
	triggerLabel: string;
	triggerTitle?: string;
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
			<PopoverTrigger
				className={triggerClassName}
				aria-haspopup="listbox"
				title={triggerTitle}
			>
				{triggerLabel}
			</PopoverTrigger>
			<PopoverContent
				align="start"
				aria-label="Choose a folder"
				className="w-64 gap-1 rounded-mdly-panel p-1.5"
			>
				<input
					// biome-ignore lint/a11y/noAutofocus: picker opened by an explicit click
					autoFocus
					aria-label="Search folders"
					placeholder="Search folders…"
					className="h-6 rounded-full bg-mdly-control px-2.5 outline-hidden focus-visible:ring-[3px] focus-visible:ring-mdly-ink/15"
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
