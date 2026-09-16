import {
	type CutCause,
	type CutPolicy,
	createCutPolicy,
} from "@mdly/doc-history";
import type { Editor } from "@tiptap/core";
import { TaskItem } from "@tiptap/extension-list";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
	EditorContent,
	type EditorOptions,
	type JSONContent,
	useEditor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	CommentComposer,
	CommentExtension,
	type CommentOptions,
	CommentParagraphMarker,
	setCommentThreads,
	setPendingCommentAnchor,
	type TextAnchor,
	ThreadPanel,
	useCommentMarkClick,
	useCommentThreads,
} from "../comments/index.js";
import {
	combineMarkdownFrontMatter,
	HeadingExtension,
	hasLinkedNotionFrontMatter,
	LinkExtension,
	listExtensions,
	MarkdownRolloverExtension,
	markdownToPlainText,
	markdownToTiptapDoc,
	NotionCalloutExtension,
	NotionEmptyBlockExtension,
	normalizeNotionMarkdownBody,
	parseMarkdownFrontMatter,
	StrikethroughShortcutExtension,
	sliceToMarkdown,
	ToggleSummaryExtension,
	tableExtensions,
	tiptapDocToMarkdown,
} from "../engine/index.js";
import { CODE_BLOCK_COPY_EVENT, HubbleCodeBlock } from "./CodeBlockExtension";
import { FindReplaceBar } from "./FindReplaceBar";
import { FindReplaceExtension } from "./FindReplaceExtension";
import { LinkClickExtension } from "./LinkClickExtension";
import { LinkCreationGhostExtension } from "./LinkCreationGhostExtension";
import { LinkPopover, type WikiTarget } from "./LinkPopover";
import { MermaidBlockViewExtension } from "./MermaidBlockView";
import { handleMarkdownTextPaste } from "./markdownPaste";
import { createNotionHtmlBlockViewExtension } from "./NotionHtmlBlockView";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { SmartLinkExtension } from "./SmartLinkExtension";
import { TableOfContents } from "./TableOfContents";
import { ToggleBlockViewExtension } from "./ToggleBlockView";
import { transactionCarriesUserEditIntent } from "./userEditIntentMeta";
import { VirtualCursor } from "./VirtualCursor";
import "./EditorView.css";
import {
	FilePropertiesPanel,
	frontMatterStateFromMarkdown,
} from "./FilePropertiesPanel";
import { FormatCommandMenu } from "./FormatCommandMenu";
import { FormattingStatusBar } from "./FormattingStatusBar";
import type { VirtualCursorMode } from "./virtualCursorMode";

// A short debounce fires a disk write (plus the workspace-store "touch" that
// follows it) on nearly every pause in typing. In large workspaces that touch
// fans out into sidebar/command-bar/wiki-link recomputation, so keep this long
// enough to coalesce normal typing pauses without noticeably delaying autosave.
const DEFAULT_SAVE_DEBOUNCE_MS = 500;
const USER_EDIT_INTENT_WINDOW_MS = 1000;
const EDITOR_FONT_ATTRIBUTE_STYLE = "font-family: var(--editor-font-family);";
const defaultExtraExtensions: NonNullable<EditorOptions["extensions"]> = [];
type EditorAttributes = NonNullable<
	NonNullable<EditorOptions["editorProps"]>["attributes"]
>;

export function hasRecentEditorUserIntent(
	lastUserEditIntentAt: number,
	now = Date.now(),
): boolean {
	return now - lastUserEditIntentAt < USER_EDIT_INTENT_WINDOW_MS;
}

export function mergeEditorFontAttributeStyle(style?: string) {
	if (!style?.trim()) return EDITOR_FONT_ATTRIBUTE_STYLE;
	if (/font-family\s*:/i.test(style)) return style;
	const separator = style.trimEnd().endsWith(";") ? " " : "; ";
	return `${style}${separator}${EDITOR_FONT_ATTRIBUTE_STYLE}`;
}

function editorAttributesWithFontStyle(
	attributes: EditorAttributes | undefined,
): EditorAttributes {
	if (typeof attributes === "function") {
		return (state) => {
			const resolvedAttributes = attributes(state);
			return {
				...resolvedAttributes,
				"data-editor-input": "",
				style: mergeEditorFontAttributeStyle(resolvedAttributes.style),
			};
		};
	}

	return {
		...attributes,
		"data-editor-input": "",
		style: mergeEditorFontAttributeStyle(attributes?.style),
	};
}

export type { WikiTarget };

export type EditorViewProps = {
	path: string;
	initialMarkdown: string;
	wikiTargets?: WikiTarget[];
	extensions?: EditorOptions["extensions"];
	editorProps?: EditorOptions["editorProps"];
	onPaste?: (editor: Editor, event: ClipboardEvent) => boolean;
	onDrop?: (editor: Editor, event: DragEvent) => boolean;
	saveDebounceMs?: number;
	/**
	 * Lets the host register a synchronous "flush draft" hook. Serialization is
	 * deferred off the keystroke path, so callers that read the last
	 * onLocalChange value as the live draft must invoke the flush first.
	 */
	registerDraftFlush?: (flush: () => void) => (() => void) | undefined;
	onLocalChange: (path: string, markdown: string) => void;
	onSave: (path: string, markdown: string) => void | Promise<void>;
	/**
	 * Whether the editor accepts user edits. Defaults to `true` — today's
	 * behaviour, unchanged for every existing consumer (the desktop app, the
	 * vendored second consumer, `apps/notion-web`). `apps/www` is the only
	 * caller that sets this `false`: the web review surface is read-only
	 * (charter R31 — "the Mac is the sole author of notes"). When `false`,
	 * ProseMirror's own `editable` option rejects direct typing, and
	 * `scheduleSave` below never fires — so `onSave` is never invoked either
	 * from the autosave debounce or from the unmount/path-change forced-save.
	 * Same discipline as the existing `chrome` prop: additive, defaulted,
	 * opt-out only.
	 */
	editable?: boolean;
	/**
	 * Fires a local-document-history cut distinct from the 500ms autosave
	 * above: once after `idleCutMs` of no typing, and again every
	 * `forcedCutMs` during a long uninterrupted typing session, plus once
	 * more when this file closes/the host unmounts with an unflushed pending
	 * save. Reuses the same force-save write path as `onSave` — callers
	 * should route this to a history-tagged save, not a second disk-write
	 * mechanism. Omit to leave history-cut timers disabled entirely.
	 */
	onIdleOrForcedCut?: (
		path: string,
		markdown: string,
		cause: CutCause,
	) => void | Promise<void>;
	/** Idle-cut window; defaults to 3 minutes. Exposed for tests only. */
	idleCutMs?: number;
	/** Forced-cut ceiling; defaults to 30 minutes. Exposed for tests only. */
	forcedCutMs?: number;
	onScrollContainerChange?: (el: HTMLDivElement | null) => void;
	onOpenExternalLink: (href: string) => void | Promise<void>;
	onOpenWikiLink: (target: string) => void | Promise<void>;
	onOpenNotionMentionLink?: (href: string) => void | Promise<void>;
	onMessage?: (message: string, type: "success" | "error") => void;
	/**
	 * Opt-in revision-timeline entry point (same convention as
	 * `onIdleOrForcedCut`): when provided, the status bar renders a small
	 * "History" affordance for `path` that calls this back on click. Omitting
	 * it renders nothing extra -- `apps/www` and `apps/notion-web` don't wire
	 * it, so they're unaffected by its existence.
	 */
	onOpenRevisionHistory?: (path: string) => void;
	/**
	 * Called with the live editor instance once it is created (and with null on
	 * teardown). Lets a host attach editor-level observers (e.g. diagnostics)
	 * without EditorView needing to depend on host-specific modules.
	 */
	onEditorReady?: (editor: Editor | null) => void;
	/**
	 * Opt-in comment thread UI (same convention as `onOpenRevisionHistory`):
	 * when provided, renders the comment mark/paragraph-marker/panel/
	 * selection-composer and keeps them synced to the live editor draft.
	 * Omitting it renders nothing extra -- hosts that don't pass it are
	 * unaffected by its existence.
	 */
	commentOptions?: CommentOptions;
};

export function EditorView({
	path,
	initialMarkdown,
	wikiTargets = [],
	extensions = defaultExtraExtensions,
	editorProps,
	onPaste,
	onDrop,
	saveDebounceMs = DEFAULT_SAVE_DEBOUNCE_MS,
	registerDraftFlush,
	onLocalChange,
	onSave,
	editable = true,
	onIdleOrForcedCut,
	idleCutMs,
	forcedCutMs,
	onScrollContainerChange,
	onOpenExternalLink,
	onOpenWikiLink,
	onOpenNotionMentionLink,
	onMessage,
	onEditorReady,
	onOpenRevisionHistory,
	commentOptions,
}: EditorViewProps) {
	const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
	// Non-null while a brand-new comment is being drafted: set by
	// `CommentComposer`'s trigger (which builds the anchor eagerly), cleared
	// on post or cancel. Drives both `ThreadPanel`'s composing UI and the
	// document-side `pm-comment-mark-pending` highlight (native selection is
	// lost once focus moves into the panel's textarea).
	const [composingAnchor, setComposingAnchor] = useState<{
		anchor: TextAnchor;
		quoteText: string;
		range: { from: number; to: number };
	} | null>(null);
	const initialFrontMatter = useMemo(
		() => parseMarkdownFrontMatter(initialMarkdown),
		[initialMarkdown],
	);
	const initialBody = bodyForEditor(initialFrontMatter);
	const partsRef = useRef({
		body: initialBody,
		frontMatter:
			initialFrontMatter.type === "none" ? "" : initialFrontMatter.raw,
	});
	const latestMarkdownRef = useRef(
		combineMarkdownFrontMatter(
			partsRef.current.frontMatter,
			partsRef.current.body,
		),
	);
	const saveTimerRef = useRef<number | null>(null);
	// Edits park here as an immutable ProseMirror doc reference (O(1) to hold)
	// and only serialize to markdown when a consumer needs the text.
	const pendingDocRef = useRef<ProseMirrorNode | null>(null);
	const lastUserEditIntentAtRef = useRef(Number.NEGATIVE_INFINITY);
	const editorRootRef = useRef<HTMLDivElement | null>(null);
	const editorViewportRef = useRef<HTMLDivElement | null>(null);
	const [editorViewportEl, setEditorViewportEl] =
		useState<HTMLDivElement | null>(null);
	const [cursorModeOverride, setCursorModeOverride] =
		useState<VirtualCursorMode | null>(null);
	const [frontMatterState, setFrontMatterState] = useState(() =>
		frontMatterStateFromMarkdown(initialMarkdown),
	);
	const [findReplaceOpen, setFindReplaceOpen] = useState(false);
	const [frontMatterSearchActive, setFrontMatterSearchActive] = useState(false);
	const pathRef = useRef(path);
	const editorRef = useRef<Editor | null>(null);
	pathRef.current = path;
	const onLocalChangeRef = useRef(onLocalChange);
	onLocalChangeRef.current = onLocalChange;
	const onIdleOrForcedCutRef = useRef(onIdleOrForcedCut);
	onIdleOrForcedCutRef.current = onIdleOrForcedCut;

	// Serializes the pending doc (if any) to markdown and syncs the internal
	// refs. Safe to call after the editor is destroyed because it works from
	// the retained doc reference, not the editor instance. Returns the markdown,
	// or null when there was nothing to serialize.
	const serializePendingDraft = useCallback(() => {
		const pendingDoc = pendingDocRef.current;
		if (!pendingDoc) return null;
		const doc = pendingDoc.toJSON() as JSONContent;
		// Keep the draft pending while an image upload placeholder is in the doc;
		// the upload completion fires another update with the final node.
		if (hasUploadImage(doc)) return null;
		pendingDocRef.current = null;
		const body = tiptapDocToMarkdown(doc);
		partsRef.current = { ...partsRef.current, body };
		const markdown = combineMarkdownFrontMatter(
			partsRef.current.frontMatter,
			body,
		);
		latestMarkdownRef.current = markdown;
		return markdown;
	}, []);

	const flushDraft = useCallback(() => {
		const markdown = serializePendingDraft();
		if (markdown !== null) onLocalChangeRef.current(pathRef.current, markdown);
	}, [serializePendingDraft]);
	const flushDraftRef = useRef(flushDraft);
	flushDraftRef.current = flushDraft;

	// Idle (3min, resettable) / forced (30min ceiling) history-cut timers,
	// distinct from the 500ms autosave debounce below (R15, R16). Created
	// once per mount; `idleCutMs`/`forcedCutMs` are read only at creation
	// (test-only overrides, not expected to change while mounted).
	const cutPolicyRef = useRef<CutPolicy | null>(null);
	if (!cutPolicyRef.current) {
		cutPolicyRef.current = createCutPolicy(
			(cause) => {
				// Flush any not-yet-serialized draft first so a cut taken inside the
				// 500ms autosave window still includes the just-typed edit (R34).
				flushDraftRef.current();
				void onIdleOrForcedCutRef.current?.(
					pathRef.current,
					latestMarkdownRef.current,
					cause,
				);
			},
			{ idleMs: idleCutMs, forcedMs: forcedCutMs },
		);
	}
	useEffect(() => {
		return () => {
			cutPolicyRef.current?.dispose();
		};
	}, []);

	useEffect(() => {
		const unregister = registerDraftFlush?.(flushDraft);
		return () => {
			unregister?.();
		};
	}, [registerDraftFlush, flushDraft]);

	const setEditorViewport = useCallback(
		(node: HTMLDivElement | null) => {
			editorViewportRef.current = node;
			setEditorViewportEl(node);
			onScrollContainerChange?.(node);
		},
		[onScrollContainerChange],
	);

	const markUserEditIntent = useCallback(() => {
		lastUserEditIntentAtRef.current = Date.now();
	}, []);

	const hasRecentUserEditIntent = useCallback(
		() => hasRecentEditorUserIntent(lastUserEditIntentAtRef.current),
		[],
	);

	// Only used at editor creation. Later file loads sync through setContent.
	// biome-ignore lint/correctness/useExhaustiveDependencies: editor instance persists across file switches.
	const initialDoc = useMemo(() => markdownToTiptapDoc(initialBody), []);

	const scheduleSave = useCallback(() => {
		// R31: the single choke point for every write path below (autosave
		// debounce here, plus the unmount/path-change forced-save further down,
		// which only fires when `saveTimerRef.current` was set by this
		// function). Read-only hosts (`apps/www`) never reach `onSave`.
		if (!editable) return;
		const savePath = pathRef.current;
		if (saveTimerRef.current !== null) {
			window.clearTimeout(saveTimerRef.current);
		}
		saveTimerRef.current = window.setTimeout(() => {
			flushDraft();
			void onSave(savePath, latestMarkdownRef.current);
		}, saveDebounceMs);
	}, [editable, flushDraft, onSave, saveDebounceMs]);

	const updateFrontMatter = useCallback(
		(
			frontMatter: string,
			nextState?: ReturnType<typeof frontMatterStateFromMarkdown>,
		) => {
			// Fold any pending body edits in first so the combined markdown below
			// doesn't resurrect a stale body.
			flushDraft();
			nextState ??= frontMatterStateFromMarkdown(
				combineMarkdownFrontMatter(frontMatter, partsRef.current.body),
			);
			partsRef.current = { ...partsRef.current, frontMatter };
			const markdown = combineMarkdownFrontMatter(
				frontMatter,
				partsRef.current.body,
			);
			latestMarkdownRef.current = markdown;
			setFrontMatterState(nextState);
			onLocalChange(pathRef.current, markdown);
			scheduleSave();
		},
		[flushDraft, onLocalChange, scheduleSave],
	);

	const setFrontMatterSearchReveal = useCallback((active: boolean) => {
		setFrontMatterSearchActive(active);
		if (!active) return;
		editorViewportRef.current?.scrollTo({
			top: 0,
			behavior: "smooth",
		});
	}, []);

	const editorExtensions = useMemo(
		() => [
			StarterKit.configure({
				codeBlock: false,
				listItem: false,
				// Cap undo history so large docs don't retain unbounded snapshots.
				undoRedo: { depth: 50 },
			}),
			HubbleCodeBlock,
			FindReplaceExtension,
			CommentExtension,
			LinkExtension,
			SmartLinkExtension,
			LinkClickExtension.configure({
				onOpenExternalLink,
				onOpenWikiLink,
				onOpenNotionMentionLink,
			}),
			LinkCreationGhostExtension,
			HeadingExtension,
			MarkdownRolloverExtension,
			StrikethroughShortcutExtension,
			NotionCalloutExtension,
			NotionEmptyBlockExtension,
			createNotionHtmlBlockViewExtension({ onOpenExternalLink }),
			MermaidBlockViewExtension,
			ToggleBlockViewExtension,
			ToggleSummaryExtension,
			...listExtensions,
			...tableExtensions,
			...extensions,
			TaskItem.configure({ nested: true }),
		],
		[extensions, onOpenExternalLink, onOpenNotionMentionLink, onOpenWikiLink],
	);
	const editorAttributes = useMemo(
		() => editorAttributesWithFontStyle(editorProps?.attributes),
		[editorProps?.attributes],
	);

	const editor = useEditor({
		extensions: editorExtensions,
		content: initialDoc,
		editable,
		onUpdate: ({ editor: current, transaction }) => {
			// R12 / ruling R-H: a gesture that commits on pointer release (a table
			// handle drag, a dot-menu Delete) can outlast the 1-second intent
			// window, so the committing transaction re-marks intent itself. The
			// window is unchanged and no global mouse-up refresher exists; only a
			// transaction that explicitly says "this is a user edit" counts.
			if (transactionCarriesUserEditIntent(transaction)) markUserEditIntent();
			// Defer O(doc) markdown serialization off the keystroke path: retain the
			// immutable doc and let flushDraft serialize when the text is needed.
			pendingDocRef.current = current.state.doc;
			if (!registerDraftFlush) {
				// Hosts without a flush hook can't commit the draft on demand, so they
				// keep eager serialization with pre-deferral publish semantics.
				const markdown = serializePendingDraft();
				if (markdown === null || !hasRecentUserEditIntent()) return;
				onLocalChangeRef.current(pathRef.current, markdown);
				scheduleSave();
				cutPolicyRef.current?.onEdit();
				return;
			}
			if (!hasRecentUserEditIntent()) return;
			scheduleSave();
			cutPolicyRef.current?.onEdit();
		},
		editorProps: {
			...editorProps,
			attributes: editorAttributes,
			clipboardTextSerializer: (slice) => sliceToMarkdown(slice),
			handlePaste: (view, event, slice): boolean => {
				if (editorProps?.handlePaste?.(view, event, slice)) return true;
				const currentEditor = editorRef.current;
				if (!currentEditor) return false;
				if (onPaste?.(currentEditor, event)) return true;
				return handleMarkdownTextPaste(currentEditor, event);
			},
			handleDrop: (view, event, slice, moved): boolean => {
				if (editorProps?.handleDrop?.(view, event, slice, moved)) return true;
				const currentEditor = editorRef.current;
				if (!currentEditor || !onDrop) return false;
				return onDrop(currentEditor, event);
			},
		},
	});
	editorRef.current = editor;

	const {
		resolvedThreads,
		error: commentsError,
		refetch: refetchCommentThreads,
	} = useCommentThreads(commentOptions, editor, markdownToPlainText);
	// Re-pushed whenever either `resolvedThreads` or `focusedThreadId` changes
	// on its own (e.g. a paragraph-marker click while the panel is already
	// open, with no new thread data) -- `setCommentThreads`'s own ignition
	// guard (comparing the combined {threads, focusedThreadId} against the
	// plugin's current state) keeps a call that changes neither from ever
	// dispatching, so one effect covers both triggers safely.
	useEffect(() => {
		if (!editor) return;
		setCommentThreads(editor, resolvedThreads, focusedThreadId);
	}, [editor, resolvedThreads, focusedThreadId]);

	// `commentOptions.onOpenThread`/`onReply`/`onResolve`/`onReopen`/`onDelete` only
	// perform the write (host IPC round-trip); nothing about a successful
	// write on its own re-triggers `useCommentThreads`'s fetch effect (it's
	// keyed on `getThreads`/docId/refreshSignal/a manual refetch(), none of
	// which change just because a mutation succeeded). Every comment mutation
	// funnels through this one wrapper so every thread surface (panel,
	// document mark click) sees the fresh state right after acting, instead
	// of only after the next unrelated re-fetch trigger.
	const withThreadsRefetch = useCallback(
		<Args extends unknown[]>(
			action: ((...args: Args) => Promise<void>) | undefined,
		) =>
			(...args: Args) =>
				(action?.(...args) ?? Promise.resolve()).then(() => {
					refetchCommentThreads();
				}),
		[refetchCommentThreads],
	);
	const handleOpenThread = useMemo(
		() => withThreadsRefetch(commentOptions?.onOpenThread),
		[withThreadsRefetch, commentOptions],
	);
	const handleReplyToThread = useMemo(
		() => withThreadsRefetch(commentOptions?.onReply),
		[withThreadsRefetch, commentOptions],
	);
	const handleResolveThread = useMemo(
		() => withThreadsRefetch(commentOptions?.onResolve),
		[withThreadsRefetch, commentOptions],
	);
	const handleReopenThread = useMemo(
		() => withThreadsRefetch(commentOptions?.onReopen),
		[withThreadsRefetch, commentOptions],
	);
	const handleDeleteThread = useMemo(
		() => withThreadsRefetch(commentOptions?.onDelete),
		[withThreadsRefetch, commentOptions],
	);

	// Builds the new-thread anchor eagerly (CommentComposer's trigger already
	// resolved it) and hands off to ThreadPanel's composing UI, keeping the
	// exact selected range highlighted in the document via the dedicated
	// "pending" decoration (native selection is lost once focus moves into
	// the panel's textarea).
	const handleStartComposing = useCallback(
		(
			anchor: TextAnchor,
			quoteText: string,
			range: { from: number; to: number },
		) => {
			setComposingAnchor({ anchor, quoteText, range });
			if (editor) setPendingCommentAnchor(editor, range);
		},
		[editor],
	);
	const clearComposing = useCallback(() => {
		setComposingAnchor(null);
		if (editor) setPendingCommentAnchor(editor, null);
	}, [editor]);

	// Shared by the paragraph-end marker (one marker per textblock grouping
	// every thread anchored in it) and by a direct click on a comment mark in
	// the document (see `useCommentMarkClick` below) -- both focus that
	// thread in the panel via the same path. Focusing an existing thread this
	// way implicitly cancels an in-progress new-comment draft first: without
	// this, the pending-anchor highlight and the newly-focused thread's own
	// highlight would both show at once, and the composer UI would stay
	// mounted alongside the now-focused thread -- one active "thing being
	// highlighted" at a time.
	const handleSelectThread = useCallback(
		(threadId: string) => {
			if (composingAnchor) clearComposing();
			setFocusedThreadId(threadId);
			commentOptions?.onPanelOpenChange?.(true);
		},
		[composingAnchor, clearComposing, commentOptions],
	);
	// Clicking a highlighted comment mark directly in the document is the
	// most direct of the four ways into a thread (the others: side panel,
	// rail marker, paragraph marker) -- ignores the mouseup of a
	// drag-selection that happens to start/end on a mark (see the hook's own
	// doc comment), which `CommentComposer`'s trigger handles instead.
	useCommentMarkClick(editor, handleSelectThread);

	// Mirrors what CommentComposer's own (now-removed) submit() did: write the
	// thread, then clear both the composing state and the pending-range
	// highlight, and make sure the panel is open to show the new thread.
	const handleSubmitNewThread = useCallback(
		async (anchor: TextAnchor, text: string) => {
			await handleOpenThread(anchor, text);
			clearComposing();
			commentOptions?.onPanelOpenChange?.(true);
		},
		[handleOpenThread, clearComposing, commentOptions],
	);
	// Dismissing the panel any other way than the composer's own Post/Cancel
	// (its Close button, Escape, or the host's own controlled `panelOpen`
	// flipping to false) must still end the draft -- otherwise the pending
	// highlight stays lit forever and, since `composingAnchor` also hides the
	// selection-triggered "Comment" trigger (see below), the user loses the
	// ability to start any new comment until they dig the buried
	// Cancel/Post back out of the reopened panel.
	const handlePanelOpenChange = useCallback(
		(open: boolean) => {
			if (!open && composingAnchor) clearComposing();
			commentOptions?.onPanelOpenChange?.(open);
		},
		[composingAnchor, clearComposing, commentOptions],
	);
	// The host can also force this panel closed from OUTSIDE that callback --
	// e.g. the desktop app's "only one right-edge panel open at a time" rule
	// (R21) flips `commentOptions.panelOpen` straight to `false` when Revision
	// History opens, without ever calling `handlePanelOpenChange` above. That
	// left composing state, the draft, and the pending highlight all stuck,
	// and the "+Comment" trigger hidden (see the `composingAnchor ? null :
	// <CommentComposer />` below) with no way to dismiss them short of
	// reopening the panel and finding Cancel. Watching the controlled prop
	// itself makes cleanup unconditional: however the panel ends up closed,
	// composing always clears. Guarded by dependency-array identity, so this
	// only fires on an actual `panelOpen` transition to `false`, never on a
	// re-render where it was already `false` (e.g. while a fresh draft is
	// still waiting for `ThreadPanel`'s own "auto-open on composing" effect to
	// flip it back to `true`).
	useEffect(() => {
		if (commentOptions?.panelOpen === false) clearComposing();
	}, [commentOptions?.panelOpen, clearComposing]);
	// Scrolls the document to a comment's anchored text when its panel item is
	// clicked. Scoped to `editor.view.dom` (the ProseMirror content root)
	// rather than `editorRootRef`, so it can only ever match the real
	// `data-thread-id` decoration span (`CommentExtension.ts`), never the
	// paragraph marker buttons that also carry the same attribute.
	const handleJumpToThread = useCallback(
		(threadId: string) => {
			editor?.view.dom
				.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`)
				?.scrollIntoView({ block: "center", behavior: "smooth" });
		},
		[editor],
	);

	const onEditorReadyRef = useRef(onEditorReady);
	onEditorReadyRef.current = onEditorReady;
	useEffect(() => {
		onEditorReadyRef.current?.(editor);
		return () => onEditorReadyRef.current?.(null);
	}, [editor]);

	useEffect(() => {
		if (!editor || !editorViewportEl) return;
		const focusEditorEnd = (event: MouseEvent) => {
			if (event.target !== editorViewportEl) return;
			editor.commands.focus("end");
		};
		editorViewportEl.addEventListener("mousedown", focusEditorEnd);
		return () =>
			editorViewportEl.removeEventListener("mousedown", focusEditorEnd);
	}, [editor, editorViewportEl]);

	useEffect(() => {
		if (!editor) return;
		// Commit pending edits before comparing, so a deferred draft is not
		// mistaken for external content divergence.
		flushDraft();
		if (initialMarkdown === latestMarkdownRef.current) {
			return;
		}
		// External content wins from here on; drop any draft flushDraft retained
		// (e.g. one held back by an in-flight image upload).
		pendingDocRef.current = null;
		const parsed = parseMarkdownFrontMatter(initialMarkdown);
		const frontMatter = parsed.type === "none" ? "" : parsed.raw;
		const body = bodyForEditor(parsed);
		partsRef.current = { body, frontMatter };
		latestMarkdownRef.current = combineMarkdownFrontMatter(frontMatter, body);
		setFrontMatterState(frontMatterStateFromMarkdown(initialMarkdown));
		const currentBody = tiptapDocToMarkdown(editor.getJSON() as JSONContent);
		if (currentBody !== body) {
			editor.commands.setContent(markdownToTiptapDoc(body), {
				emitUpdate: false,
			});
		}
	}, [editor, flushDraft, initialMarkdown]);

	useEffect(() => {
		return () => {
			if (saveTimerRef.current !== null) {
				window.clearTimeout(saveTimerRef.current);
				saveTimerRef.current = null;
				flushDraft();
				void onSave(path, latestMarkdownRef.current);
				// This cleanup fires both on a path change (opening a different
				// file/workspace) and on true unmount (closing the file) — intended
				// as a forced-cut moment for whatever edit the 500ms autosave
				// debounce had not yet caught (R17). NOTE: for a path change driven
				// by the app's `loadPath` (its only file-to-file switch path),
				// `currentPath` has already moved to the new path by the time this
				// runs, so both calls above are no-ops there (their consumers guard
				// on `currentPath === path`) — `loadPath`'s own proactive
				// outgoing-file save (in `apps/desktop/src/store/actions.ts`) is what
				// actually captures that edit's history, tagged with
				// `historyCause: 'idle-session'`. This effect still does real work
				// for a true component unmount that isn't a `loadPath` switch.
				void onIdleOrForcedCutRef.current?.(
					path,
					latestMarkdownRef.current,
					"forced",
				);
			}
		};
	}, [path, onSave, flushDraft]);

	useEffect(() => {
		if (!onMessage) return;
		const handleCopyMessage = (event: Event) => {
			const detail = (event as CustomEvent).detail as
				| { message?: unknown; type?: unknown }
				| undefined;
			if (typeof detail?.message !== "string") return;
			onMessage(detail.message, detail.type === "error" ? "error" : "success");
		};
		window.addEventListener(CODE_BLOCK_COPY_EVENT, handleCopyMessage);
		return () =>
			window.removeEventListener(CODE_BLOCK_COPY_EVENT, handleCopyMessage);
	}, [onMessage]);

	useEffect(() => {
		const handleFindShortcut = (event: KeyboardEvent) => {
			if (event.key.toLocaleLowerCase() !== "f") return;
			if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
			event.preventDefault();
			setFindReplaceOpen(true);
		};
		window.addEventListener("keydown", handleFindShortcut, true);
		return () =>
			window.removeEventListener("keydown", handleFindShortcut, true);
	}, []);

	return (
		<div
			className="relative flex h-full min-h-0 flex-col"
			ref={editorRootRef}
			data-hubble-editor
			onBeforeInputCapture={markUserEditIntent}
			onDropCapture={markUserEditIntent}
			onKeyDownCapture={markUserEditIntent}
			onPasteCapture={markUserEditIntent}
			onPointerDownCapture={markUserEditIntent}
		>
			<div
				className="editorViewport relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
				ref={setEditorViewport}
			>
				<FilePropertiesPanel
					path={path}
					state={frontMatterState}
					searchActive={frontMatterSearchActive}
					onChange={(nextState, frontMatter) => {
						updateFrontMatter(frontMatter, nextState);
					}}
				/>
				<EditorContent editor={editor} />
				<VirtualCursor
					editor={editor}
					containerRef={editorRootRef}
					viewportRef={editorViewportRef}
					modeOverride={cursorModeOverride}
				/>
				<LinkPopover
					editor={editor}
					containerRef={editorRootRef}
					viewportRef={editorViewportRef}
					wikiTargets={wikiTargets}
					onOpenExternalLink={onOpenExternalLink}
					onOpenWikiLink={onOpenWikiLink}
					onOpenNotionMentionLink={onOpenNotionMentionLink}
					onMessage={onMessage}
					onCursorModeChange={setCursorModeOverride}
				/>
				<SlashCommandMenu editor={editor} viewportRef={editorViewportRef} />
				<FormatCommandMenu editor={editor} viewportRef={editorViewportRef} />
				<TableOfContents
					editor={editor}
					scrollContainer={editorViewportEl}
					threads={commentOptions ? resolvedThreads : undefined}
				/>
				{commentOptions ? (
					<>
						<CommentParagraphMarker
							editor={editor}
							containerRef={editorRootRef}
							threads={resolvedThreads}
							onSelectThread={handleSelectThread}
						/>
						{/* Hidden once a draft is in progress -- the panel's own
						NewThreadComposer is now the one "start a comment" affordance
						for that selection; without this, both would show at once. */}
						{composingAnchor ? null : (
							<CommentComposer
								editor={editor}
								viewportRef={editorViewportRef}
								getHeadRevisionId={commentOptions.getHeadRevisionId}
								readRevisionContent={commentOptions.readRevisionContent}
								onStartComposing={handleStartComposing}
							/>
						)}
					</>
				) : null}
			</div>
			<FindReplaceBar
				editor={editor}
				open={findReplaceOpen}
				frontMatter={{
					text: partsRef.current.frontMatter,
					onReplace: updateFrontMatter,
				}}
				onOpenChange={setFindReplaceOpen}
				onFrontMatterActiveChange={setFrontMatterSearchReveal}
			/>
			<FormattingStatusBar
				editor={editor}
				path={path}
				onOpenRevisionHistory={onOpenRevisionHistory}
			/>
			{commentOptions ? (
				<ThreadPanel
					threads={resolvedThreads}
					currentAuthor={commentOptions.currentAuthor}
					focusedThreadId={focusedThreadId}
					open={commentOptions.panelOpen}
					onOpenChange={handlePanelOpenChange}
					onReply={handleReplyToThread}
					onResolve={handleResolveThread}
					onReopen={handleReopenThread}
					onDelete={handleDeleteThread}
					onJumpToThread={handleJumpToThread}
					error={commentsError}
					// Passed as the `composingAnchor` state reference itself (a
					// superset of ThreadPanel's `composing` shape), not a freshly
					// literal-constructed object -- ThreadPanel's own "auto-open on
					// composing" effect is keyed on this prop's identity, and a new
					// object every render would re-fire that effect (and force the
					// panel back open) on every unrelated EditorView re-render while
					// composing is active, fighting the panel's own Close/Escape.
					composing={composingAnchor}
					onSubmitNewThread={handleSubmitNewThread}
					onCancelCompose={clearComposing}
				/>
			) : null}
		</div>
	);
}

function bodyForEditor(
	parsed: ReturnType<typeof parseMarkdownFrontMatter>,
): string {
	if (parsed.type === "none") return parsed.body;
	return hasLinkedNotionFrontMatter(parsed.raw)
		? normalizeNotionMarkdownBody(parsed.body)
		: parsed.body;
}

function hasUploadImage(node: JSONContent): boolean {
	if (node.type === "image" && node.attrs?.uploadId) return true;
	return node.content?.some(hasUploadImage) ?? false;
}
