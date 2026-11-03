import MingcuteFolderLine from "~icons/mingcute/folder-line";
import { cn } from "../lib/utils";
import { ROOT_FOLDER_LABEL } from "./documentTableEngine";

/**
 * Innermost folder of a folder label ("a/b/sqlite" → "sqlite"). Empty for the
 * workspace root ("—" / ""), so callers omit the chip there — the row already
 * sits in that workspace, so naming it adds nothing.
 */
export function lastFolderName(folderLabel: string): string {
	if (!folderLabel || folderLabel === ROOT_FOLDER_LABEL) return "";
	const segments = folderLabel.split(/[\\/]/).filter(Boolean);
	return segments[segments.length - 1] ?? "";
}

/**
 * Compact folder meta chip for card rows: folder icon + the last folder name,
 * full path on hover. Same pill tokens as the tag chips (`.mdly-chip`), sized
 * down to fit the card's meta line; long names end-ellipsize.
 */
export function FolderChip({
	folderLabel,
	className,
}: {
	folderLabel: string;
	className?: string;
}) {
	const name = lastFolderName(folderLabel);
	if (!name) return null;
	return (
		<span
			data-folder-chip=""
			title={folderLabel}
			className={cn(
				"mdly-chip min-w-0 max-w-full shrink [block-size:18px] [font-size:11px] [padding-inline:6px]",
				className,
			)}
		>
			<MingcuteFolderLine aria-hidden="true" className="size-3 shrink-0" />
			<span className="min-w-0 truncate">{name}</span>
		</span>
	);
}
