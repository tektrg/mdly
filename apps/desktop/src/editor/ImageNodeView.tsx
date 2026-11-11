import { ContextMenu } from "@base-ui/react/context-menu";
import { usePortalContainer, ZoomViewer } from "@mdly/workspace-kit";
import type { Node as PMNode } from "@tiptap/pm/model";
import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import MingcuteCopy2Line from "~icons/mingcute/copy-2-line";
import MingcuteFolderOpenLine from "~icons/mingcute/folder-open-line";
import MingcuteFullscreenLine from "~icons/mingcute/fullscreen-line";
import MingcuteLoading3Line from "~icons/mingcute/loading-3-line";
import { desktopApi } from "../desktopApi";
import { revealFileLabel } from "../lib/revealFile";
import { persistPastedImage } from "./handleImagePaste";

const MIN_RESIZE_WIDTH = 48;
const MENU_ITEM_CLASS =
	"flex w-full cursor-pointer items-center gap-2 rounded-mdly-control px-2 py-1.5 text-start text-xs outline-hidden select-none data-highlighted:bg-accent";

type ViewerImage = { src: string; alt: string };

const uploads = new Map<string, Promise<string>>();

export function ImageNodeView({
	node,
	filePath,
	selected,
	updateAttributes,
	editor,
	getPos,
}: NodeViewProps & { filePath: string }) {
	const rawSrc = String(node.attrs.src ?? "");
	const uploadId =
		typeof node.attrs.uploadId === "string" ? node.attrs.uploadId : null;
	const uploadFile =
		node.attrs.uploadFile instanceof File ? node.attrs.uploadFile : null;
	const width = typeof node.attrs.width === "number" ? node.attrs.width : 640;
	const height =
		typeof node.attrs.height === "number" ? node.attrs.height : 360;
	const [resolvedSrc, setResolvedSrc] = useState(rawSrc);
	const hasMeasuredFrame =
		typeof node.attrs.width === "number" &&
		typeof node.attrs.height === "number";
	const portalContainer = usePortalContainer();
	const [dragWidth, setDragWidth] = useState<number | null>(null);
	const dragRef = useRef<{ x: number; width: number } | null>(null);
	const frameRef = useRef<HTMLDivElement | null>(null);
	const [viewer, setViewer] = useState<{
		images: ViewerImage[];
		index: number;
	} | null>(null);
	const displayWidth =
		dragWidth ?? (typeof node.attrs.width === "number" ? width : null);
	const frameStyle: CSSProperties | undefined =
		displayWidth === null
			? undefined
			: hasMeasuredFrame && dragWidth === null
				? { inlineSize: `${width}px`, aspectRatio: `${width} / ${height}` }
				: { inlineSize: `${displayWidth}px` };
	const absolutePath = isResolvableLocalPath(rawSrc)
		? joinPath(dirname(filePath), rawSrc)
		: null;

	const openViewer = () => {
		const pos = typeof getPos === "function" ? getPos() : undefined;
		if (typeof pos === "number") editor.commands.setNodeSelection(pos);
		const siblings =
			typeof pos === "number" ? columnGroupImages(editor.state.doc, pos) : null;
		const own = { src: rawSrc, alt: String(node.attrs.alt ?? "") };
		const list = siblings ?? { images: [own], index: 0 };
		void Promise.all(
			list.images.map(async (image) => ({
				alt: image.alt,
				src: await resolveImageSrc(image.src, filePath),
			})),
		).then((images) => setViewer({ images, index: list.index }));
	};

	const copyPath = async () => {
		try {
			await navigator.clipboard.writeText(absolutePath ?? rawSrc);
			toast.success("Copied image path");
		} catch {
			toast.error("Failed to copy path");
		}
	};

	const revealImage = async () => {
		if (!absolutePath) return;
		try {
			await desktopApi.revealFile(await desktopApi.resolvePath(absolutePath));
		} catch {
			toast.error("Failed to reveal image");
		}
	};

	const onResizeDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		const current = frameRef.current?.getBoundingClientRect().width ?? width;
		dragRef.current = { x: event.clientX, width: current };
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onResizeMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		const max =
			frameRef.current?.parentElement?.getBoundingClientRect().width ??
			Number.POSITIVE_INFINITY;
		setDragWidth(
			Math.round(
				Math.min(
					max,
					Math.max(MIN_RESIZE_WIDTH, drag.width + event.clientX - drag.x),
				),
			),
		);
	};
	const onResizeUp = () => {
		const drag = dragRef.current;
		dragRef.current = null;
		if (!drag) return;
		if (dragWidth !== null)
			updateAttributes({ width: dragWidth, height: null });
		setDragWidth(null);
	};

	useEffect(() => {
		if (!uploadId || !uploadFile || rawSrc) return;
		let cancelled = false;
		void uploadOnce(uploadId, filePath, uploadFile)
			.then((src) => {
				if (cancelled) return;
				// The placeholder width/height were only for the loading frame;
				// clear them so the image isn't saved with a `|WxH` size suffix.
				updateAttributes({
					src,
					uploadId: null,
					uploadStatus: null,
					uploadFile: null,
					width: null,
					height: null,
				});
			})
			.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				toast.error("Failed to paste image", { description: message });
				if (!cancelled) {
					updateAttributes({
						uploadId: null,
						uploadStatus: "error",
						uploadFile: null,
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [filePath, rawSrc, updateAttributes, uploadFile, uploadId]);

	useEffect(() => {
		let cancelled = false;
		if (rawSrc.trim().length === 0) {
			setResolvedSrc("");
			return;
		}
		if (!isResolvableLocalPath(rawSrc)) {
			setResolvedSrc(rawSrc);
			return;
		}
		setResolvedSrc("");
		const unresolvedPath = joinPath(dirname(filePath), rawSrc);
		void desktopApi
			.resolvePath(unresolvedPath)
			.then((absolutePath) => {
				if (!cancelled) setResolvedSrc(desktopApi.toAssetUrl(absolutePath));
			})
			.catch(() => {
				if (!cancelled) setResolvedSrc("");
			});
		return () => {
			cancelled = true;
		};
	}, [rawSrc, filePath]);

	const canView = resolvedSrc.length > 0 && !uploadId;
	const current = viewer?.images[viewer.index];

	return (
		<NodeViewWrapper as="div" data-drag-handle>
			<ContextMenu.Root disabled={!canView}>
				<ContextMenu.Trigger
					render={
						<div
							ref={frameRef}
							className={[
								"pm-image-frame",
								hasMeasuredFrame && dragWidth === null
									? "pm-image-frame-measured"
									: "",
								displayWidth !== null ? "pm-image-frame-sized" : "",
							]
								.filter(Boolean)
								.join(" ")}
							style={frameStyle}
						/>
					}
				>
					{uploadId && rawSrc.length === 0 ? (
						<UploadPlaceholder />
					) : resolvedSrc.length > 0 ? (
						// Click only selects the node (ProseMirror default); the full-screen
						// viewer opens from the right-click menu.
						<img
							src={resolvedSrc}
							alt={node.attrs.alt || ""}
							title={node.attrs.title || undefined}
							className={selected ? "outline-2 outline-ring" : ""}
						/>
					) : (
						<div className="pm-image-missing">Image unavailable</div>
					)}
					{canView && editor.isEditable ? (
						<span
							className="pm-image-resize-handle"
							contentEditable={false}
							aria-hidden="true"
							title="Drag to resize"
							onPointerDown={onResizeDown}
							onPointerMove={onResizeMove}
							onPointerUp={onResizeUp}
							onPointerCancel={onResizeUp}
						/>
					) : null}
				</ContextMenu.Trigger>
				<ContextMenu.Portal container={portalContainer}>
					<ContextMenu.Positioner className="z-50">
						<ContextMenu.Popup className="min-w-44 origin-(--transform-origin) rounded-[18px] bg-popover p-1 text-popover-foreground shadow-overlay outline-hidden">
							<ContextMenu.Item
								className={MENU_ITEM_CLASS}
								onClick={openViewer}
							>
								<MingcuteFullscreenLine
									className="size-3.5"
									aria-hidden="true"
								/>
								View full screen
							</ContextMenu.Item>
							<ContextMenu.Item
								className={MENU_ITEM_CLASS}
								onClick={() => void copyPath()}
							>
								<MingcuteCopy2Line className="size-3.5" aria-hidden="true" />
								Copy path
							</ContextMenu.Item>
							{absolutePath ? (
								<ContextMenu.Item
									className={MENU_ITEM_CLASS}
									onClick={() => void revealImage()}
								>
									<MingcuteFolderOpenLine
										className="size-3.5"
										aria-hidden="true"
									/>
									{revealFileLabel(desktopApi.platform)}
								</ContextMenu.Item>
							) : null}
						</ContextMenu.Popup>
					</ContextMenu.Positioner>
				</ContextMenu.Portal>
			</ContextMenu.Root>
			<ZoomViewer
				open={viewer !== null}
				onOpenChange={(open) => {
					if (!open) setViewer(null);
				}}
				title={current?.alt || "Image"}
				contentKey={String(viewer?.index ?? 0)}
				onPrevious={
					viewer && viewer.index > 0
						? () => setViewer({ ...viewer, index: viewer.index - 1 })
						: undefined
				}
				onNext={
					viewer && viewer.index < viewer.images.length - 1
						? () => setViewer({ ...viewer, index: viewer.index + 1 })
						: undefined
				}
			>
				{current ? (
					<img
						className="pm-image-viewer-img"
						src={current.src}
						alt={current.alt}
						draggable={false}
					/>
				) : null}
			</ZoomViewer>
		</NodeViewWrapper>
	);
}

/**
 * When the image at `pos` sits inside a `columns` group, every image in that
 * group in document order plus this image's index — so the viewer can step
 * through them with the arrow keys. Null outside a columns group.
 */
export function columnGroupImages(
	doc: PMNode,
	pos: number,
): { images: ViewerImage[]; index: number } | null {
	const $pos = doc.resolve(pos);
	for (let depth = $pos.depth; depth > 0; depth -= 1) {
		const group = $pos.node(depth);
		if (group.type.name !== "columns") continue;
		const start = $pos.start(depth);
		const images: ViewerImage[] = [];
		let index = 0;
		group.descendants((child, offset) => {
			if (child.type.name !== "image") return true;
			const src = String(child.attrs.src ?? "");
			if (!src) return false;
			if (start + offset === pos) index = images.length;
			images.push({ src, alt: String(child.attrs.alt ?? "") });
			return false;
		});
		return images.length > 0 ? { images, index } : null;
	}
	return null;
}

async function resolveImageSrc(rawSrc: string, filePath: string) {
	if (!isResolvableLocalPath(rawSrc)) return rawSrc;
	try {
		const absolute = await desktopApi.resolvePath(
			joinPath(dirname(filePath), rawSrc),
		);
		return desktopApi.toAssetUrl(absolute);
	} catch {
		return "";
	}
}

function uploadOnce(id: string, filePath: string, file: File): Promise<string> {
	const existing = uploads.get(id);
	if (existing) return existing;
	const upload = persistPastedImage({ filePath, imageFile: file }).finally(
		() => {
			uploads.delete(id);
		},
	);
	uploads.set(id, upload);
	return upload;
}

function UploadPlaceholder() {
	return (
		<div className="pm-image-upload-placeholder">
			<div className="pm-image-upload-placeholder-shimmer" />
			<MingcuteLoading3Line
				aria-label="Uploading image"
				className="pm-image-upload-spinner"
			/>
		</div>
	);
}

function dirname(filePath: string): string {
	const normalized = filePath.split("\\").join("/");
	const idx = normalized.lastIndexOf("/");
	if (idx <= 0) return normalized;
	return normalized.slice(0, idx);
}

function normalizePosixPath(path: string): string {
	const parts = path.split("/");
	const stack: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			stack.pop();
			continue;
		}
		stack.push(part);
	}
	return `/${stack.join("/")}`;
}

function joinPath(baseDir: string, relativePath: string): string {
	const rel = safeDecodeUriComponent(relativePath).split("\\").join("/");
	if (rel === "~" || rel.startsWith("~/")) return rel;
	if (rel.startsWith("/")) return normalizePosixPath(rel);
	return normalizePosixPath(`${baseDir}/${rel}`);
}

function isResolvableLocalPath(src: string): boolean {
	return !/^(data:|https?:|file:|asset:|hubble-asset:)/i.test(src);
}

function safeDecodeUriComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
