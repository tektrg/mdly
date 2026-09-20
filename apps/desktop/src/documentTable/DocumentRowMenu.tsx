import { ActionItem, ActionsMenu } from "@mdly/workspace-kit";
import MingcuteCopy2Line from "~icons/mingcute/copy-2-line";
import MingcuteDeleteLine from "~icons/mingcute/delete-line";
import MingcuteFolderOpenLine from "~icons/mingcute/folder-open-line";
import MingcutePinLine from "~icons/mingcute/pin-line";
import type { DocumentTableRow } from "./documentTableView";

/** File actions for one document-table row, driven by absolute file path. */
export type DocumentRowMenuHandlers = {
	onRevealPath: (path: string) => void;
	onCopyPath: (path: string) => void;
	onMovePath: (path: string) => void;
	onTogglePin: (path: string) => void;
	onDeletePath: (path: string) => void;
};

/** Everything DocumentRowList needs to offer a row its menu. */
export type DocumentRowListMenu = DocumentRowMenuHandlers & {
	/** Pin state per row, read from the workspace store by the host. */
	isPinned: (path: string) => boolean;
	revealLabel: string;
};

/**
 * "..." trigger style mirroring the kit sidebar's own trigger, re-armed onto
 * this list's hover group so it reveals on row hover here too. Written as a
 * literal (not composed at runtime) because Tailwind only emits classes it can
 * see in the source text.
 */
export const DOCUMENT_ROW_MENU_TRIGGER_CLASS =
	"inline-flex size-5 shrink-0 items-center justify-center rounded-sm border border-transparent bg-transparent text-muted-foreground/70 opacity-0 outline-hidden transition-[opacity,color] hover:text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/40 group-hover/document-row:opacity-100 aria-expanded:text-foreground aria-expanded:opacity-100";

/**
 * The title column's menu: the sidebar file row's items in the same order with
 * the same labels, icons and shortcuts — minus Rename, which the table has no
 * inline UI for yet (user ruling: Rename arrives with Delivery A's inline
 * rename; the menu grows the item then). Rendered through the kit's
 * `ActionsMenu`/`ActionItem` so the two surfaces cannot drift.
 */
export function DocumentRowMenu({
	row,
	pinned,
	revealLabel,
	open,
	onOpenChange,
	handlers,
}: {
	row: DocumentTableRow;
	pinned: boolean;
	revealLabel: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	handlers: DocumentRowMenuHandlers;
}) {
	return (
		<ActionsMenu
			label={row.name}
			open={open}
			onOpenChange={onOpenChange}
			triggerClassName={DOCUMENT_ROW_MENU_TRIGGER_CLASS}
		>
			<ActionItem
				icon={<MingcuteFolderOpenLine />}
				onClick={() => handlers.onRevealPath(row.path)}
				shortcut="⌘⌥R"
			>
				{revealLabel}
			</ActionItem>
			<ActionItem
				icon={<MingcuteCopy2Line />}
				onClick={() => handlers.onCopyPath(row.path)}
				shortcut="⌘⇧C"
			>
				Copy file path
			</ActionItem>
			<ActionItem
				icon={<MingcuteFolderOpenLine />}
				onClick={() => handlers.onMovePath(row.path)}
			>
				Move to...
			</ActionItem>
			<ActionItem
				icon={<MingcutePinLine />}
				onClick={() => handlers.onTogglePin(row.path)}
			>
				{pinned ? "Unpin" : "Pin"}
			</ActionItem>
			<ActionItem
				destructive
				icon={<MingcuteDeleteLine />}
				onClick={() => handlers.onDeletePath(row.path)}
			>
				Delete
			</ActionItem>
		</ActionsMenu>
	);
}
