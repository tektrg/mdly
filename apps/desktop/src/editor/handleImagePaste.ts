import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { desktopApi } from "../desktopApi";

export async function persistPastedImage({
	filePath,
	imageFile,
}: {
	filePath: string;
	imageFile: File;
}): Promise<string> {
	const bytes = Array.from(new Uint8Array(await imageFile.arrayBuffer()));
	const result = await desktopApi.persistPastedImage({
		filePath,
		bytes,
		mimeType: imageFile.type || null,
	});
	const relativeMarkdownPath = result.relativeMarkdownPath;
	if (relativeMarkdownPath.trim().length === 0) {
		throw new Error("Image persisted but returned empty markdown path.");
	}
	return relativeMarkdownPath;
}

export function handleImagePaste({
	editor,
	event,
}: {
	editor: Editor | null;
	event: ClipboardEvent;
}): boolean {
	if (!editor) return false;
	const items = event.clipboardData?.items;
	if (!items) return false;
	const imageFiles = Array.from(items)
		.filter((item) => item.type.startsWith("image/"))
		.map((item) => item.getAsFile())
		.filter((file): file is File => file !== null);
	if (imageFiles.length === 0) return false;
	event.preventDefault();
	void insertUploadImages({ editor, files: imageFiles });
	return true;
}

export function handleImageDrop({
	editor,
	event,
}: {
	editor: Editor | null;
	event: DragEvent;
}): boolean {
	if (!editor) return false;
	const imageFiles = Array.from(event.dataTransfer?.files ?? []).filter(
		(file) => file.type.startsWith("image/"),
	);
	if (imageFiles.length === 0) return false;
	event.preventDefault();
	const pos = editor.view.posAtCoords({
		left: event.clientX,
		top: event.clientY,
	})?.pos;
	void insertUploadImages({ editor, files: imageFiles, pos });
	return true;
}

/**
 * `/image` slash command: opens the native file picker and inserts the chosen
 * images at the caret through the same upload path as paste/drop (several
 * images become a columns group, like a multi-drop).
 */
export async function pickAndInsertImages(
	editor: Editor,
	{
		openPicker = openImageFilePicker,
		insert = insertUploadImages,
	}: {
		openPicker?: () => Promise<File[]>;
		insert?: (args: { editor: Editor; files: File[] }) => Promise<void>;
	} = {},
): Promise<void> {
	const files = (await openPicker()).filter((file) =>
		file.type.startsWith("image/"),
	);
	if (files.length === 0 || editor.isDestroyed) return;
	await insert({ editor, files });
}

/** Native multi-select image picker (Electron shows the system dialog). */
export function openImageFilePicker(): Promise<File[]> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.multiple = true;
		input.addEventListener("change", () =>
			resolve(Array.from(input.files ?? [])),
		);
		input.addEventListener("cancel", () => resolve([]));
		input.click();
	});
}

/** Most images placed side by side in one columns group. */
export const MAX_IMAGES_PER_COLUMNS_GROUP = 4;

/**
 * Splits dropped/pasted images into groups for side-by-side layout: one image
 * stays a plain image; several become columns groups of at most `max` images.
 * Inside an existing column (columns never nest) every image stays single.
 */
export function groupImagesForColumns<T>(
	files: T[],
	insideColumn: boolean,
	max = MAX_IMAGES_PER_COLUMNS_GROUP,
): T[][] {
	if (files.length <= 1 || insideColumn) return files.map((file) => [file]);
	const groups: T[][] = [];
	for (let index = 0; index < files.length; index += max) {
		groups.push(files.slice(index, index + max));
	}
	return groups;
}

export async function insertUploadImages({
	editor,
	files,
	pos,
}: {
	editor: Editor;
	files: File[];
	pos?: number;
}) {
	const { schema } = editor;
	const insertPos = pos ?? editor.state.selection.from;
	const $insert = editor.state.doc.resolve(
		Math.min(insertPos, editor.state.doc.content.size),
	);
	let insideColumn = false;
	for (let depth = $insert.depth; depth > 0; depth -= 1) {
		if ($insert.node(depth).type.name === "column") insideColumn = true;
	}
	const imageNodes = await Promise.all(
		files.map(async (file) => {
			const size = placeholderSize(await decodeImageSize(file));
			return schema.nodes.image?.create({
				src: "",
				alt: "",
				uploadId: crypto.randomUUID(),
				uploadStatus: "uploading",
				uploadFile: file,
				width: size.width,
				height: size.height,
			});
		}),
	);
	if (imageNodes.some((node) => !node)) return;
	const blocks = groupImagesForColumns(
		imageNodes as NonNullable<(typeof imageNodes)[number]>[],
		insideColumn || !schema.nodes.columns || !schema.nodes.column,
	).map((group) =>
		group.length === 1
			? group[0]
			: schema.nodes.columns.create(
					null,
					group.map((image) => schema.nodes.column.create(null, image)),
				),
	);
	const paragraphNode = schema.nodes.paragraph?.create();
	if (!paragraphNode || blocks.length === 0) return;

	const transaction = editor.state.tr.insert(insertPos, [
		...blocks,
		paragraphNode,
	]);
	const insertedSize = blocks.reduce((sum, node) => sum + node.nodeSize, 0);
	const cursorPos = insertPos + insertedSize + 1;
	editor.view.dispatch(
		transaction.setSelection(
			TextSelection.near(transaction.doc.resolve(cursorPos)),
		),
	);
	editor.commands.focus();
}

function decodeImageSize(
	file: File,
): Promise<{ width: number; height: number }> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		const cleanup = () => URL.revokeObjectURL(url);
		img.onload = () => {
			const width = img.naturalWidth || 640;
			const height = img.naturalHeight || 360;
			cleanup();
			resolve({ width, height });
		};
		img.onerror = () => {
			cleanup();
			resolve({ width: 640, height: 360 });
		};
		img.src = url;
	});
}

function placeholderSize({
	width,
	height,
}: {
	width: number;
	height: number;
}): { width: number; height: number } {
	const maxWidth = 900;
	if (width <= maxWidth) return { width, height };
	return { width: maxWidth, height: Math.round((height / width) * maxWidth) };
}
