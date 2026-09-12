import { Button, Modal } from "@hubble.md/ui";
import { useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";
import type {
	SyncFolderSummary,
	SyncPreview,
	SyncProgress,
} from "../desktopApi/types";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCount(n: number): string {
	return n.toLocaleString();
}

const AUTO_EXCLUDE_REASON_LABELS: Record<
	NonNullable<SyncFolderSummary["autoExcluded"]>,
	string
> = {
	gitignored: "excluded — ignored",
	"nested-repo": "excluded — nested repo",
	"over-threshold": "excluded — over 1,000 files/folders",
};

/**
 * First-sync review dialog (D-LW4): folder-grouped checkbox tree over the
 * ENGINE-BACKED plan preview — the same `plan()` the real sync executes, so
 * the counts shown are the counts that happen. Excluded tops arrive as
 * greyed rows with their engine-emitted reason and stay re-includable
 * (check the box). Scan progress is real (indeterminate count-up from the
 * walk); the determinate totals appear with the plan.
 */
export function CloudSyncReviewDialog({
	open,
	onOpenChange,
	workspacePath,
	workspaceName,
	deploymentUrl,
	password,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspacePath: string;
	workspaceName: string;
	deploymentUrl: string;
	password?: string;
	onConfirm: (excluded: string[]) => void;
}) {
	const [preview, setPreview] = useState<SyncPreview | null>(null);
	const [scanProgress, setScanProgress] = useState<SyncProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Folder path → will sync. Initialized from the preview: plan rows
	// selected, excluded rows cleared (greyed, re-includable).
	const [selected, setSelected] = useState<Set<string> | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: fetch once per open; the inputs are the open-time snapshot.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setPreview(null);
		setScanProgress(null);
		setError(null);
		setSelected(null);
		let unsubscribe: (() => void) | undefined;
		void desktopApi
			.onCloudSyncProgressChange(workspacePath, (prog) => {
				if (!cancelled) setScanProgress(prog);
			})
			.then((fn) => {
				if (cancelled) fn();
				else unsubscribe = fn;
			});
		void desktopApi
			.getCloudSyncPreview(workspacePath, {
				workspaceName,
				deploymentUrl,
				password,
			})
			.then((result) => {
				if (cancelled) return;
				setPreview(result);
				setSelected(
					new Set(
						result.folders.filter((f) => !f.autoExcluded).map((f) => f.folder),
					),
				);
			})
			.catch((e: unknown) => {
				if (cancelled) return;
				setError(e instanceof Error ? e.message : String(e));
			});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [open, workspacePath]);

	if (!open) return null;

	const toggle = (folder: string) => {
		setSelected((prev) => {
			if (!prev) return prev;
			const next = new Set(prev);
			if (next.has(folder)) next.delete(folder);
			else next.add(folder);
			return next;
		});
	};

	const handleConfirm = () => {
		if (!preview || !selected) return;
		const excluded = preview.folders
			.filter((f) => f.folder !== "(root)")
			.filter((f) => !selected.has(f.folder))
			.map((f) => f.folder);
		onConfirm(excluded);
	};

	const selectedNotes =
		preview && selected
			? preview.folders
					.filter((f) => selected.has(f.folder))
					.reduce((n, f) => n + f.fileCount, 0)
			: 0;

	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title="Review what will sync"
			description="Uncheck folders to leave them on this Mac. Everything else syncs — including folders added later, unless they grow past 1,000 files or folders."
			className="flex h-[70vh] max-w-2xl flex-col"
		>
			{error ? (
				<span className="text-[11px] leading-4 text-destructive">{error}</span>
			) : !preview || !selected ? (
				<span className="text-[11px] leading-4 text-muted-foreground">
					{scanProgress &&
					scanProgress.phase === "scan" &&
					scanProgress.done > 0
						? `Scanning workspace… ${formatCount(scanProgress.done)} entries so far`
						: "Scanning workspace… folders appear here as they are counted."}
				</span>
			) : (
				<>
					<span className="text-[11px] leading-4 text-muted-foreground">
						{formatCount(preview.toPush + preview.toPull)} to sync
						{preview.conflicts > 0
							? ` · ${formatCount(preview.conflicts)} conflicts`
							: ""}
						{` · ${formatCount(selectedNotes)} notes selected`}
					</span>
					<div className="min-h-0 flex-1 overflow-y-auto">
						<ul className="flex flex-col gap-1">
							{preview.folders.map((folder) => {
								const excluded = !selected.has(folder.folder);
								return (
									<FolderRow
										key={folder.folder}
										folder={folder}
										excluded={excluded}
										checked={selected.has(folder.folder)}
										selectable={folder.folder !== "(root)"}
										onToggle={() => toggle(folder.folder)}
									/>
								);
							})}
						</ul>
					</div>
				</>
			)}
			<div className="mt-3 flex shrink-0 justify-end gap-2">
				<Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button
					variant="default"
					size="sm"
					disabled={!preview || !selected}
					onClick={handleConfirm}
				>
					Enable sync
				</Button>
			</div>
		</Modal>
	);
}

function FolderRow({
	folder,
	excluded,
	checked,
	selectable,
	onToggle,
}: {
	folder: SyncFolderSummary;
	excluded: boolean;
	checked: boolean;
	selectable: boolean;
	onToggle: () => void;
}) {
	return (
		<li
			className={`flex items-center gap-2 rounded-sm [padding-block:0.375rem] [padding-inline:0.5rem] ${
				excluded ? "opacity-55" : ""
			}`}
		>
			<input
				type="checkbox"
				checked={checked}
				disabled={!selectable}
				onChange={onToggle}
				aria-label={`Sync ${folder.folder}`}
			/>
			<span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
				{folder.folder}
			</span>
			<span className="shrink-0 text-[11px] text-muted-foreground">
				{folder.autoExcluded
					? `${formatCount(folder.fileCount)}+ files`
					: `${formatCount(folder.fileCount)} notes · ${formatBytes(folder.bytes)}`}
			</span>
			{folder.autoExcluded && (
				<span className="shrink-0 text-[11px] text-muted-foreground">
					{AUTO_EXCLUDE_REASON_LABELS[folder.autoExcluded]}
				</span>
			)}
		</li>
	);
}
