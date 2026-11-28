import { Button } from "@hubble.md/ui";
import { groupChangeRegions } from "@mdly/doc-history";
import {
	DiffChangeRail,
	DiffGroupsView,
	EditorView,
	formatRevisionTime,
	type ReadRevisionContentResult,
} from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { desktopApi } from "../desktopApi";
import type { HistoryRevision } from "../desktopApi/types";
import { createEmbedExtension } from "../editor/EmbedExtension";
import { buildExternalChangeSuggestions } from "../editor/externalChangeDiff";
import { createImageExtension } from "../editor/ImageExtension";
import {
	getSuggestions,
	SuggestionExtension,
	suggestionKey,
} from "../editor/SuggestionExtension";
import { workspaceStore } from "../store/state";

type SelectionState =
	| { status: "loading" }
	| { status: "loaded"; content: string }
	| { status: "unavailable" }
	| { status: "not-found" }
	| { status: "error"; message: string };

const CAUSE_LABELS: Record<string, string> = {
	"external-write": "Edited outside the app",
	"idle-session": "Autosaved",
	manual: "You reviewed and merged this",
	import: "Imported",
	restore: "Restored from history",
};

const noop = () => {};

/**
 * Full-pane, read-only diff of one revision against the note's current content.
 * Defaults to the rich WYSIWYG inline diff (same `SuggestionExtension`
 * decorations used by AI edits and external-change review), with a one-click
 * toggle to the raw Markdown diff (`DiffGroupsView` + `DiffChangeRail`).
 */
export function RevisionInlineDiffView({
	path,
	revision,
	currentContent,
	onReadRevisionContent,
	onBack,
}: {
	path: string;
	revision: HistoryRevision;
	currentContent: string;
	onReadRevisionContent: (
		revisionId: string,
	) => Promise<ReadRevisionContentResult>;
	onBack: () => void;
}) {
	const workspacePath = useStoreValue(
		workspaceStore,
		(workspace) => workspace.workspacePath,
	);
	const [selection, setSelection] = useState<SelectionState>({
		status: "loading",
	});
	const [mode, setMode] = useState<"rich" | "raw">("rich");
	const [liveEditor, setLiveEditor] = useState<Editor | null>(null);
	const [frontMatterChanged, setFrontMatterChanged] = useState(false);
	const [navState, setNavState] = useState<{ count: number; index: number }>({
		count: 0,
		index: 0,
	});
	const rawContainerRef = useRef<HTMLDivElement | null>(null);
	const readRevisionRef = useRef(onReadRevisionContent);
	readRevisionRef.current = onReadRevisionContent;

	useEffect(() => {
		let active = true;
		setSelection({ status: "loading" });
		readRevisionRef
			.current(revision.id)
			.then((result) => {
				if (!active) return;
				if (result.status === "ok") {
					setSelection({ status: "loaded", content: result.content });
				} else {
					setSelection({ status: result.status });
				}
			})
			.catch((err: unknown) => {
				if (!active) return;
				setSelection({
					status: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			});
		return () => {
			active = false;
		};
	}, [revision.id]);

	const editorExtensions = useMemo(
		() => [
			SuggestionExtension,
			createImageExtension(path),
			createEmbedExtension({ workspacePath, filePath: path }),
		],
		[path, workspacePath],
	);

	// Track active index / total changes for the header navigation controls.
	useEffect(() => {
		if (!liveEditor) {
			setNavState({ count: 0, index: 0 });
			return;
		}
		const update = () => {
			const changes = getSuggestions(liveEditor.state);
			const activeId = suggestionKey.getState(liveEditor.state)?.activeId;
			const idx = Math.max(
				0,
				changes.findIndex((c) => c.id === activeId),
			);
			setNavState({ count: changes.length, index: idx });
		};
		update();
		liveEditor.on("transaction", update);
		return () => {
			liveEditor.off("transaction", update);
		};
	}, [liveEditor]);

	// Populate inline diff decorations whenever the loaded revision or live
	// document changes while in rich mode.
	useEffect(() => {
		if (mode !== "rich" || !liveEditor || selection.status !== "loaded") {
			return;
		}
		const { changes, frontMatterChanged: fmChanged } =
			buildExternalChangeSuggestions(
				selection.content,
				currentContent,
				liveEditor.state.doc,
				liveEditor.schema,
				`rev-${revision.id}`,
			);
		setFrontMatterChanged(fmChanged);
		liveEditor.commands.setAppliedSuggestions("external", changes);
		// Auto-scroll to the first diff hunk so the user lands directly on a change.
		const firstId = changes[0]?.id;
		if (firstId && typeof requestAnimationFrame === "function") {
			const rafId = requestAnimationFrame(() => {
				if (liveEditor.isDestroyed) return;
				const el = liveEditor.view.dom.querySelector(
					`[data-suggestion-id="${firstId}"]`,
				);
				el?.scrollIntoView({ behavior: "smooth", block: "center" });
			});
			return () => cancelAnimationFrame(rafId);
		}
	}, [mode, liveEditor, selection, currentContent, revision.id]);

	const groups = useMemo(
		() =>
			selection.status === "loaded"
				? groupChangeRegions(selection.content, currentContent)
				: [],
		[selection, currentContent],
	);

	const handleEditorReady = useCallback((editor: Editor | null) => {
		setLiveEditor(editor);
	}, []);

	const isLoaded = selection.status === "loaded";

	return (
		<div className="flex h-full min-h-0 flex-col" data-revision-diff-view>
			{/* pt-11 matches the invisible macOS window-drag strip at the top of the pane. */}
			<div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/60 px-4 pt-11 pb-2">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate font-medium text-sm">
						{CAUSE_LABELS[revision.cause] ?? revision.cause}
					</span>
					<span className="shrink-0 text-muted-foreground text-xs">
						{formatRevisionTime(revision.at)}
					</span>
					{isLoaded && mode === "rich" && (
						<span className="shrink-0 text-muted-foreground text-xs">
							·{" "}
							{navState.count > 0
								? `${navState.index + 1}/${navState.count} change${navState.count === 1 ? "" : "s"}`
								: frontMatterChanged
									? "Frontmatter changed"
									: "No changes"}
						</span>
					)}
					{isLoaded &&
						mode === "rich" &&
						frontMatterChanged &&
						navState.count > 0 && (
							<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
								+frontmatter
							</span>
						)}
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{isLoaded && mode === "rich" && navState.count > 0 && (
						<div className="flex items-center gap-0.5">
							<Button
								variant="ghost"
								size="sm"
								title="Previous change"
								onClick={() => liveEditor?.commands.nextSuggestion(-1)}
							>
								↑
							</Button>
							<Button
								variant="ghost"
								size="sm"
								title="Next change"
								onClick={() => liveEditor?.commands.nextSuggestion(1)}
							>
								↓
							</Button>
						</div>
					)}
					{isLoaded && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setMode((m) => (m === "rich" ? "raw" : "rich"))}
						>
							{mode === "rich" ? "Raw diff" : "Rich diff"}
						</Button>
					)}
					<Button variant="soft" size="sm" onClick={onBack}>
						Back to editor
					</Button>
				</div>
			</div>

			{selection.status !== "loaded" ? (
				<div className="min-h-0 flex-1 overflow-y-auto p-4" data-revision-diff>
					<StatusMessage selection={selection} />
				</div>
			) : mode === "raw" ? (
				<div className="relative min-h-0 flex-1">
					<div
						ref={rawContainerRef}
						data-revision-diff
						className="h-full overflow-y-auto p-4 pe-8"
					>
						<DiffGroupsView
							groups={groups}
							emptyMessage="No changes since this revision."
						/>
					</div>
					<DiffChangeRail groups={groups} containerRef={rawContainerRef} />
				</div>
			) : (
				<div
					className="flex min-h-0 flex-1 flex-col overflow-hidden"
					data-revision-diff
					data-revision-diff-mode="rich"
				>
					{navState.count === 0 && frontMatterChanged && (
						<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
							<span>Only frontmatter changed since this revision.</span>
							<button
								type="button"
								className="font-medium text-foreground underline underline-offset-2"
								onClick={() => setMode("raw")}
							>
								View raw diff
							</button>
						</div>
					)}
					<div className="min-h-0 flex-1">
						<EditorView
							path={path}
							initialMarkdown={currentContent}
							editable={false}
							hideInfoChips
							extensions={editorExtensions}
							onLocalChange={noop}
							onSave={noop}
							onOpenExternalLink={desktopApi.openExternalUrl}
							onOpenWikiLink={noop}
							onEditorReady={handleEditorReady}
						/>
					</div>
				</div>
			)}
		</div>
	);
}

function StatusMessage({
	selection,
}: {
	selection: Exclude<SelectionState, { status: "loaded" }>;
}) {
	if (selection.status === "loading") {
		return <p className="m-0 text-muted-foreground text-xs">Loading…</p>;
	}
	if (selection.status === "unavailable") {
		return (
			<p
				className="m-0 text-muted-foreground text-xs"
				data-revision-unavailable
			>
				This revision's content is unavailable.
			</p>
		);
	}
	if (selection.status === "not-found") {
		return (
			<p
				className="m-0 text-muted-foreground text-xs"
				data-revision-unavailable
			>
				This revision could not be found.
			</p>
		);
	}
	return (
		<p className="m-0 text-destructive text-xs" data-revision-error>
			Failed to load this revision: {selection.message}
		</p>
	);
}
