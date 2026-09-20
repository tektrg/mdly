import { RevisionDiffView } from "@mdly/workspace-kit";
import { useShallow, useStoreValue } from "@simplestack/store/react";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import MingcuteLoading3Line from "~icons/mingcute/loading-3-line";
import { desktopApi } from "../desktopApi";
import type { HistoryRevision } from "../desktopApi/types";
import { DocumentNarrowList } from "../documentTable/DocumentNarrowList";
import type { DocumentRowListMenu } from "../documentTable/DocumentRowMenu";
import { DocumentTable } from "../documentTable/DocumentTable";
import { resolveDocumentListingState } from "../documentTable/documentListingState";
import {
	setDocumentTableFilter,
	toggleDocumentTableSort,
} from "../documentTable/documentTableStore";
import { clampPeekListWidth, densityTier } from "../documentTable/navDensity";
import { PeekListDivider } from "../documentTable/PeekListDivider";
import {
	PEEK_LIST_DEFAULT_WIDTH,
	setPeekListDesiredWidth,
} from "../documentTable/peekListWidth";
import { useDocumentTableRows } from "../documentTable/useDocumentTableRows";
import { useNavContainerWidth } from "../documentTable/useNavContainerWidth";
import { PEEK_DOCUMENT_MIN_WIDTH } from "../lib/navLayout";
import { revealFileLabel } from "../lib/revealFile";
import {
	deleteMarkdownFile,
	loadPath,
	refreshFiles,
	togglePinnedNote,
} from "../store/actions";
import { closeDocumentToTable } from "../store/closeDocument";
import {
	viewerStore,
	workspacePathStore,
	workspaceStore,
} from "../store/state";
import { DocumentViewer } from "./DocumentViewer";
import { RevisionHistoryPanel } from "./RevisionHistoryPanel";
import { WelcomeScreen } from "./WelcomeScreen";

type MainPanelProps = {
	hasWorkspace: boolean;
	onCreateFolder: () => void;
	onOpenFolder: () => void;
	/** Opens the "Move to…" destination picker for a table row's file. */
	onMoveFile: (path: string) => void;
	notionDatabaseRefreshToken: number;
	onScrollContainerChange: (el: HTMLDivElement | null) => void;
	historyOpen: boolean;
	onHistoryOpenChange: (open: boolean) => void;
	commentsOpen: boolean;
	onCommentsOpenChange: (open: boolean) => void;
	viewingRevision: HistoryRevision | null;
	onViewingRevisionChange: (revision: HistoryRevision | null) => void;
};

/**
 * The single layout switch, derived from one field:
 * `requestedPath === null` is the full-width table; anything else is the
 * narrow list plus the document pane.
 *
 * Loading and error live **inside** the document pane, never around it — that
 * is the whole of R5: a slow or failed open leaves the list on screen and
 * clickable, so another document is always one click away.
 */
export function MainPanel({
	hasWorkspace,
	onCreateFolder,
	onOpenFolder,
	onMoveFile,
	notionDatabaseRefreshToken,
	onScrollContainerChange,
	historyOpen,
	onHistoryOpenChange,
	commentsOpen,
	onCommentsOpenChange,
	viewingRevision,
	onViewingRevisionChange,
}: MainPanelProps) {
	const { requestedPath, currentPath, status, error } = useStoreValue(
		viewerStore,
		useShallow((viewer) => ({
			requestedPath: viewer.requestedPath,
			currentPath: viewer.currentPath,
			status: viewer.status,
			error: viewer.error,
		})),
	);
	const listing = useStoreValue(
		workspaceStore,
		useShallow((workspace) => resolveDocumentListingState(workspace)),
	);
	// Peek split wiring. Declared before the early returns below so hook order
	// never changes; the browse branch simply never reads these values.
	const workspacePath = useStoreValue(workspacePathStore);
	const peekDesiredWidth = useStoreValue(workspaceStore, (workspace) => {
		if (!workspacePath) return PEEK_LIST_DEFAULT_WIDTH;
		const stored = workspace.peekListWidths[workspacePath];
		return typeof stored === "number" && Number.isFinite(stored) && stored > 0
			? stored
			: PEEK_LIST_DEFAULT_WIDTH;
	});
	const splitRef = useRef<HTMLDivElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);
	const [peekResizing, setPeekResizing] = useState(false);
	const { splitWidth, listWidth } = useNavContainerWidth(splitRef, listRef);
	const handlePeekResize = useCallback(
		(rawWidth: number) => {
			const measured = splitRef.current?.getBoundingClientRect().width ?? 0;
			const availableWidth =
				measured > 0 ? measured : rawWidth + PEEK_DOCUMENT_MIN_WIDTH;
			const { listWidth: clamped } = clampPeekListWidth({
				availableWidth,
				desiredWidth: rawWidth,
			});
			setPeekListDesiredWidth(workspacePath ?? null, clamped);
		},
		[workspacePath],
	);
	const pinnedNotes = useStoreValue(
		workspaceStore,
		(workspace) => workspace.pinnedNotes,
	);
	// A document that is still loading — or that failed — is still the row the
	// user is looking at, so the list highlights `requestedPath`, not the
	// document that finished loading.
	const { rows, view } = useDocumentTableRows(
		requestedPath === null ? null : requestedPath,
	);
	// Title-column menu: the sidebar file row's actions (minus Rename, which
	// needs inline UI the table doesn't have yet), wired to the same store
	// actions and the same failure toasts as the sidebar.
	const rowMenu: DocumentRowListMenu = {
		isPinned: (path) => pinnedNotes.includes(path),
		revealLabel: revealFileLabel(desktopApi.platform),
		onRevealPath: (path) => {
			void desktopApi
				.revealFile(path)
				.catch(() => toast.error("Failed to reveal file"));
		},
		onCopyPath: (path) => {
			void navigator.clipboard
				.writeText(path)
				.then(() => toast.success("File path copied"))
				.catch(() => toast.error("Failed to copy file path"));
		},
		onMovePath: (path) => onMoveFile(path),
		onTogglePin: (path) => void togglePinnedNote(path),
		onDeletePath: (path) => void deleteMarkdownFile(path),
	};

	if (!hasWorkspace) {
		return (
			<div className="flex h-full items-center justify-center p-6">
				<WelcomeScreen
					onCreateFolder={onCreateFolder}
					onOpenFolder={onOpenFolder}
				/>
			</div>
		);
	}

	if (requestedPath === null) {
		return (
			<DocumentTable
				rows={rows}
				view={view}
				listing={listing}
				onOpenDocument={(row) => void loadPath(row.openPath)}
				onFilterChange={setDocumentTableFilter}
				onToggleSort={toggleDocumentTableSort}
				onRetryListing={() => void refreshFiles()}
				rowMenu={rowMenu}
			/>
		);
	}

	// R13 at render time only: a narrow window clamps the list without
	// rewriting the persisted desire, so widening restores it (EC-30).
	const peekAvailableWidth =
		splitWidth > 0 ? splitWidth : peekDesiredWidth + PEEK_DOCUMENT_MIN_WIDTH;
	const { listWidth: clampedPeekWidth } = clampPeekListWidth({
		availableWidth: peekAvailableWidth,
		desiredWidth: peekDesiredWidth,
	});
	// R9 reads the MEASURED list, falling back to the clamped desire before
	// the observers have fired (or where there is no layout at all).
	const peekTier = densityTier(listWidth > 0 ? listWidth : clampedPeekWidth);

	return (
		<div
			ref={splitRef}
			data-peek-split
			{...(peekResizing ? { "data-resizing": "" } : {})}
			className="flex h-full min-h-0 flex-1 overflow-hidden"
		>
			<DocumentNarrowList
				rows={rows}
				view={view}
				listing={listing}
				onOpenDocument={(row) => void loadPath(row.openPath)}
				onFilterChange={setDocumentTableFilter}
				onShowAllDocuments={() => void closeDocumentToTable()}
				onRetryListing={() => void refreshFiles()}
				listRef={listRef}
				navTier={peekTier}
				listInlineSize={clampedPeekWidth}
				rowMenu={rowMenu}
			/>
			<PeekListDivider
				splitRef={splitRef}
				listWidth={clampedPeekWidth}
				onResize={handlePeekResize}
				onResizeStart={() => setPeekResizing(true)}
				onResizeEnd={() => setPeekResizing(false)}
			/>
			<div
				data-document-pane
				className="flex min-h-0 flex-1 flex-col overflow-hidden"
			>
				{status === "loading" ? (
					<p
						aria-live="polite"
						aria-busy="true"
						className="m-0 flex items-center gap-2 p-3 text-sm text-muted-foreground"
					>
						<MingcuteLoading3Line
							aria-hidden="true"
							className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
						/>
						Opening this document…
					</p>
				) : null}
				{status === "error" ? (
					<p aria-live="polite" className="m-0 p-3 text-sm text-destructive">
						{error ?? "Failed to open file."}
					</p>
				) : null}
				{status === "ready" && currentPath ? (
					<ReadyDocument
						currentPath={currentPath}
						notionDatabaseRefreshToken={notionDatabaseRefreshToken}
						onScrollContainerChange={onScrollContainerChange}
						historyOpen={historyOpen}
						onHistoryOpenChange={onHistoryOpenChange}
						commentsOpen={commentsOpen}
						onCommentsOpenChange={onCommentsOpenChange}
						viewingRevision={viewingRevision}
						onViewingRevisionChange={onViewingRevisionChange}
					/>
				) : null}
			</div>
		</div>
	);
}

// Isolates the live-content subscription so per-keystroke content updates
// re-render only the document view, not the whole App shell.
function ReadyDocument({
	currentPath,
	notionDatabaseRefreshToken,
	onScrollContainerChange,
	historyOpen,
	onHistoryOpenChange,
	commentsOpen,
	onCommentsOpenChange,
	viewingRevision,
	onViewingRevisionChange,
}: {
	currentPath: string;
	notionDatabaseRefreshToken: number;
	onScrollContainerChange: (el: HTMLDivElement | null) => void;
	historyOpen: boolean;
	onHistoryOpenChange: (open: boolean) => void;
	commentsOpen: boolean;
	onCommentsOpenChange: (open: boolean) => void;
	viewingRevision: HistoryRevision | null;
	onViewingRevisionChange: (revision: HistoryRevision | null) => void;
}) {
	const content = useStoreValue(viewerStore, (viewer) => viewer.content);

	// Only one right-edge panel is ever open at a time (R21), and every such
	// panel is a fixed overlay (SidePanel, w-80) -- without this offset it
	// covers the document's centered column instead of the document yielding
	// the space. Padding the pane by the panel width shifts the centered
	// content left so it stays fully visible while a panel is open.
	const rightPanelOpen = historyOpen || commentsOpen;

	// The history panel, the comments panel, and any revision the former is
	// showing a diff for all belong to the document they were opened for --
	// close/clear them rather than let them leak onto whatever note this
	// component next renders for (R27's per-document scoping precedent). The
	// review/conflict pill lives in the title bar (Toolbar) now and resets
	// itself the same way, keyed off its own currentPath subscription.
	// biome-ignore lint/correctness/useExhaustiveDependencies: currentPath is the reset signal, not read in the body.
	useEffect(() => {
		onHistoryOpenChange(false);
		onCommentsOpenChange(false);
		onViewingRevisionChange(null);
	}, [currentPath]);

	return (
		<div
			className="flex h-full min-h-0 flex-col transition-[padding] duration-300 ease-snappy motion-reduce:transition-none"
			style={
				rightPanelOpen
					? ({
							paddingInlineEnd: "min(20rem, calc(100vw - 2rem))",
							// Keeps the viewport-fixed TOC rail (workspace-kit)
							// usable: it reads this width to yield the same space.
							"--hubble-right-panel-inline-size":
								"min(20rem, calc(100vw - 2rem))",
						} as CSSProperties)
					: undefined
			}
		>
			{viewingRevision ? (
				<RevisionDiffView
					revision={viewingRevision}
					currentContent={content}
					onReadRevisionContent={(revisionId) =>
						desktopApi.readRevisionContent(currentPath, revisionId)
					}
					onBack={() => onViewingRevisionChange(null)}
				/>
			) : (
				<DocumentViewer
					path={currentPath}
					content={content}
					notionDatabaseRefreshToken={notionDatabaseRefreshToken}
					onScrollContainerChange={onScrollContainerChange}
					commentsOpen={commentsOpen}
					onCommentsOpenChange={onCommentsOpenChange}
				/>
			)}
			<RevisionHistoryPanel
				open={historyOpen}
				onOpenChange={(open) => {
					onHistoryOpenChange(open);
					// Nothing left to browse the diff from once the panel closes.
					if (!open) onViewingRevisionChange(null);
				}}
				path={currentPath}
				selectedRevisionId={viewingRevision?.id ?? null}
				onSelectRevision={onViewingRevisionChange}
			/>
		</div>
	);
}
