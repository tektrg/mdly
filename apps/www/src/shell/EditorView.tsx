import {
	EditorView as SharedEditorView,
	type WikiTarget,
	wikiDisplayNameForTarget,
} from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import type { Editor } from "@tiptap/core";
import { useCallback } from "react";
import { useCommentOptions } from "../comments/useCommentOptions";
import {
	loadPath,
	saveNoteNow,
	updateEditorContent,
	uploadAssetFile,
} from "../store/actions";
import { filesStore, viewerStore } from "../store/state";
import { createWebImageExtension } from "./WebImageExtension";

type Props = {
	path: string;
	initialMarkdown: string;
	onEditorReady?: (editor: Editor | null) => void;
	onScrollContainerChange?: (el: HTMLDivElement | null) => void;
};

/**
 * Web write-back: the garden editor is writable again (R31 reversed
 * 2026-09-15). Typing flows through the shared kit's debounced save
 * (`onLocalChange` → staged push; `onSave` → immediate push), and pasted /
 * dropped images upload through `uploadAssetFile` then insert as a standard
 * `image` node (`{type:"image", attrs:{src, alt}}` — the kit's own
 * markdown contract), which the save path then persists like any other edit.
 * `createWebImageExtension()` resolves each image's authenticated download
 * URL for rendering.
 */
export function EditorView({
	path,
	initialMarkdown,
	onEditorReady,
	onScrollContainerChange,
}: Props) {
	const files = useStoreValue(filesStore);
	const wikiTargets: WikiTarget[] = files.map((file) => ({
		path: file.path,
		target: file.path,
		title: wikiDisplayNameForTarget(file.path),
	}));
	// Web commenting is still unwired (stubs throw "coming soon") — undefined
	// keeps the whole comment UI dark until slice 6.
	const commentOptions = useCommentOptions(path);

	const handlePaste = useCallback(
		(editor: Editor, event: ClipboardEvent): boolean => {
			const file = pastedImageFile(event);
			if (!file) return false;
			event.preventDefault();
			void insertUploadedImage(editor, path, file);
			return true;
		},
		[path],
	);
	const handleDrop = useCallback(
		(editor: Editor, event: DragEvent): boolean => {
			const file = droppedImageFile(event);
			if (!file) return false;
			event.preventDefault();
			const pos = editor.view.posAtCoords({
				left: event.clientX,
				top: event.clientY,
			})?.pos;
			void insertUploadedImage(editor, path, file, pos);
			return true;
		},
		[path],
	);

	return (
		<SharedEditorView
			path={path}
			initialMarkdown={initialMarkdown}
			wikiTargets={wikiTargets}
			extensions={[createWebImageExtension()]}
			onLocalChange={updateEditorContent}
			onSave={(savePath, markdown) => {
				void saveNoteNow(savePath, markdown);
			}}
			onPaste={handlePaste}
			onDrop={handleDrop}
			commentOptions={commentOptions}
			onEditorReady={onEditorReady}
			onScrollContainerChange={onScrollContainerChange}
			onOpenExternalLink={(href) => {
				window.open(href, "_blank", "noopener");
			}}
			onOpenWikiLink={(target) => void loadPath(target.split("#")[0] ?? target)}
		/>
	);
}

function pastedImageFile(event: ClipboardEvent): File | null {
	const items = event.clipboardData?.items;
	if (!items) return null;
	return (
		Array.from(items)
			.find((item) => item.type.startsWith("image/"))
			?.getAsFile() ?? null
	);
}

function droppedImageFile(event: DragEvent): File | null {
	return (
		Array.from(event.dataTransfer?.files ?? []).find((file) =>
			file.type.startsWith("image/"),
		) ?? null
	);
}

async function insertUploadedImage(
	editor: Editor,
	notePath: string,
	file: File,
	pos?: number,
): Promise<void> {
	let markdownPath: string;
	try {
		markdownPath = await uploadAssetFile({ path: notePath, file });
	} catch (err) {
		failSave(err instanceof Error ? err.message : String(err));
		return;
	}
	if (editor.isDestroyed) return;
	const image = {
		type: "image",
		attrs: { src: markdownPath, alt: file.name },
	};
	if (pos === undefined) {
		editor.chain().focus().insertContent(image).run();
	} else {
		editor.chain().focus().insertContentAt(pos, image).run();
	}
	// The insert fires the kit's onUpdate → onLocalChange, so the debounced
	// push picks the image up like any typed edit. Nothing more to do here.
}

function failSave(message: string): void {
	const viewer = viewerStore.get();
	viewerStore.set({ ...viewer, saveError: message });
}
