import {
	combineMarkdownFrontMatter,
	HeadingExtension,
	hasLinkedNotionFrontMatter,
	LinkExtension,
	listExtensions,
	MarkdownRolloverExtension,
	markdownToTiptapDoc,
	NotionCalloutExtension,
	NotionEmptyBlockExtension,
	normalizeNotionMarkdownBody,
	parseMarkdownFrontMatter,
	StrikethroughShortcutExtension,
	tableExtensions,
	tiptapDocToMarkdown,
} from "@hubble.md/editor";
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
import { CODE_BLOCK_COPY_EVENT, HubbleCodeBlock } from "./CodeBlockExtension";
import { FindReplaceBar } from "./FindReplaceBar";
import { FindReplaceExtension } from "./FindReplaceExtension";
import { LinkClickExtension } from "./LinkClickExtension";
import { LinkCreationGhostExtension } from "./LinkCreationGhostExtension";
import { LinkPopover, type WikiTarget } from "./LinkPopover";
import { MermaidBlockViewExtension } from "./MermaidBlockView";
import { createNotionHtmlBlockViewExtension } from "./NotionHtmlBlockView";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { SmartLinkExtension } from "./SmartLinkExtension";
import { TableOfContents } from "./TableOfContents";
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
	registerDraftFlush?: (flush: () => void) => (() => void) | void;
	onLocalChange: (path: string, markdown: string) => void;
	onSave: (path: string, markdown: string) => void | Promise<void>;
	onScrollContainerChange?: (el: HTMLDivElement | null) => void;
	onOpenExternalLink: (href: string) => void | Promise<void>;
	onOpenWikiLink: (target: string) => void | Promise<void>;
	onOpenNotionMentionLink?: (href: string) => void | Promise<void>;
	onMessage?: (message: string, type: "success" | "error") => void;
	/**
	 * Called with the live editor instance once it is created (and with null on
	 * teardown). Lets a host attach editor-level observers (e.g. diagnostics)
	 * without EditorView needing to depend on host-specific modules.
	 */
	onEditorReady?: (editor: Editor | null) => void;
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
	onScrollContainerChange,
	onOpenExternalLink,
	onOpenWikiLink,
	onOpenNotionMentionLink,
	onMessage,
	onEditorReady,
}: EditorViewProps) {
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
		const savePath = pathRef.current;
		if (saveTimerRef.current !== null) {
			window.clearTimeout(saveTimerRef.current);
		}
		saveTimerRef.current = window.setTimeout(() => {
			flushDraft();
			void onSave(savePath, latestMarkdownRef.current);
		}, saveDebounceMs);
	}, [flushDraft, onSave, saveDebounceMs]);

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
		onUpdate: ({ editor: current }) => {
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
				return;
			}
			if (!hasRecentUserEditIntent()) return;
			scheduleSave();
		},
		editorProps: {
			...editorProps,
			attributes: editorAttributes,
			handlePaste: (view, event, slice): boolean => {
				if (editorProps?.handlePaste?.(view, event, slice)) return true;
				const currentEditor = editorRef.current;
				if (!currentEditor || !onPaste) return false;
				return onPaste(currentEditor, event);
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
				className="editorViewport relative min-h-0 flex-1 overflow-auto overscroll-contain"
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
				<TableOfContents editor={editor} scrollContainer={editorViewportEl} />
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
				scrollContainer={editorViewportEl}
			/>
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
