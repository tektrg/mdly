import {
	combineMarkdownFrontMatter,
	HeadingExtension,
	hasLinkedNotionFrontMatter,
	LinkExtension,
	listExtensions,
	MarkdownRolloverExtension,
	markdownToTiptapDoc,
	normalizeNotionMarkdownBody,
	notionBlockExtensions,
	parseMarkdownFrontMatter,
	StrikethroughShortcutExtension,
	tableExtensions,
	tiptapDocToMarkdown,
} from "@hubble.md/editor";
import type { Editor } from "@tiptap/core";
import { TaskItem } from "@tiptap/extension-list";
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

const DEFAULT_SAVE_DEBOUNCE_MS = 120;
const USER_EDIT_INTENT_WINDOW_MS = 1000;

export function hasRecentEditorUserIntent(
	lastUserEditIntentAt: number,
	now = Date.now(),
): boolean {
	return now - lastUserEditIntentAt < USER_EDIT_INTENT_WINDOW_MS;
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
	onLocalChange: (path: string, markdown: string) => void;
	onSave: (path: string, markdown: string) => void | Promise<void>;
	onScrollContainerChange?: (el: HTMLDivElement | null) => void;
	onOpenExternalLink: (href: string) => void | Promise<void>;
	onOpenWikiLink: (target: string) => void | Promise<void>;
	onOpenNotionMentionLink?: (href: string) => void | Promise<void>;
	onMessage?: (message: string, type: "success" | "error") => void;
};

export function EditorView({
	path,
	initialMarkdown,
	wikiTargets = [],
	extensions = [],
	editorProps,
	onPaste,
	onDrop,
	saveDebounceMs = DEFAULT_SAVE_DEBOUNCE_MS,
	onLocalChange,
	onSave,
	onScrollContainerChange,
	onOpenExternalLink,
	onOpenWikiLink,
	onOpenNotionMentionLink,
	onMessage,
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
			void onSave(savePath, latestMarkdownRef.current);
		}, saveDebounceMs);
	}, [onSave, saveDebounceMs]);

	const updateFrontMatter = useCallback(
		(
			frontMatter: string,
			nextState = frontMatterStateFromMarkdown(
				combineMarkdownFrontMatter(frontMatter, partsRef.current.body),
			),
		) => {
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
		[onLocalChange, scheduleSave],
	);

	const setFrontMatterSearchReveal = useCallback((active: boolean) => {
		setFrontMatterSearchActive(active);
		if (!active) return;
		editorViewportRef.current?.scrollTo({
			top: 0,
			behavior: "smooth",
		});
	}, []);

	const editor = useEditor({
		extensions: [
			StarterKit.configure({ codeBlock: false, listItem: false }),
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
			...notionBlockExtensions,
			...listExtensions,
			...tableExtensions,
			...extensions,
			TaskItem.configure({ nested: true }),
		],
		content: initialDoc,
		onUpdate: ({ editor: current }) => {
			const doc = current.getJSON() as JSONContent;
			if (hasUploadImage(doc)) return;
			const body = tiptapDocToMarkdown(doc);
			partsRef.current = { ...partsRef.current, body };
			const markdown = combineMarkdownFrontMatter(
				partsRef.current.frontMatter,
				body,
			);
			latestMarkdownRef.current = markdown;
			if (!hasRecentUserEditIntent()) return;
			onLocalChange(pathRef.current, markdown);
			scheduleSave();
		},
		editorProps: {
			...editorProps,
			attributes: {
				...editorProps?.attributes,
				"data-editor-input": "",
			},
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
		if (initialMarkdown === latestMarkdownRef.current) {
			return;
		}
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
	}, [editor, initialMarkdown]);

	useEffect(() => {
		return () => {
			if (saveTimerRef.current !== null) {
				window.clearTimeout(saveTimerRef.current);
				saveTimerRef.current = null;
				void onSave(path, latestMarkdownRef.current);
			}
		};
	}, [path, onSave]);

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
			<FormattingStatusBar editor={editor} scrollContainer={editorViewportEl} />
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
