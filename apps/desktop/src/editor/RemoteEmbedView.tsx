import { ContextMenu } from "@base-ui/react/context-menu";
import { Dialog } from "@base-ui/react/dialog";
import { readIframeAttr, usePortalContainer } from "@mdly/workspace-kit";
import { type NodeViewProps, NodeViewWrapper } from "@tiptap/react";
import {
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import MingcuteCopy2Line from "~icons/mingcute/copy-2-line";
import MingcuteExternalLinkLine from "~icons/mingcute/external-link-line";
import MingcuteFullscreenLine from "~icons/mingcute/fullscreen-line";
import MingcuteGlobeLine from "~icons/mingcute/globe-line";
import MingcuteRefresh2Line from "~icons/mingcute/refresh-2-line";
import { desktopApi } from "../desktopApi";

/**
 * Sandbox for remote (https) embeds.
 *
 * - `allow-scripts` + `allow-same-origin`: real embeds (YouTube, X, SheetCanvas)
 *   need JS plus their OWN cookies/storage. "Same origin" here means the remote
 *   site's own origin (e.g. https://www.youtube.com), never mdly's: the frame is
 *   cross-origin to the app (`app://mdly` / the dev server), so the browser's
 *   same-origin policy still blocks `window.parent` DOM access, and the preload
 *   `desktopApi` only exists in the main frame (`nodeIntegrationInSubFrames`
 *   is off). The script+same-origin escape only matters when the framed page
 *   shares the parent's origin, which an https URL cannot.
 * - `allow-popups`: "Watch on YouTube" / tweet links. Electron main denies every
 *   popup window and opens the URL in the system browser instead.
 * - `allow-presentation`, `allow-forms`: players and embedded forms.
 * - Deliberately NOT `allow-top-navigation*`: an embed can never navigate the
 *   app window (main also cancels off-origin `will-navigate` as a backstop).
 *
 * Remote embeds also never get the HTML-app file API: unlike local `.html`
 * embeds (IframeView) they have no `name` token and no message handler.
 */
export const REMOTE_EMBED_SANDBOX =
	"allow-scripts allow-same-origin allow-popups allow-presentation allow-forms";

const DEFAULT_HEIGHT = 400;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 4000;
const MENU_ITEM_CLASS =
	"flex w-full cursor-pointer items-center gap-2 rounded-mdly-control px-2 py-1.5 text-start text-xs outline-hidden select-none data-highlighted:bg-accent";

/** `100%` → `100%`, `550` → `550px`, `550px` → `550px`; anything else → full width. */
export function embedWidthCss(width: unknown): string {
	const value = typeof width === "string" ? width.trim() : "";
	if (/^\d+(\.\d+)?$/.test(value)) return `${value}px`;
	if (/^\d+(\.\d+)?(px|%)$/.test(value)) return value;
	return "100%";
}

/** Pixel height from the `height` attr (`800` / `800px`), else a default. */
export function embedHeightPx(height: unknown): number {
	const value = typeof height === "string" ? height.trim() : "";
	const match = /^(\d+(?:\.\d+)?)(px)?$/.exec(value);
	const parsed = match ? Number(match[1]) : Number.NaN;
	if (!(parsed > 0)) return DEFAULT_HEIGHT;
	return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(parsed)));
}

export function sameEmbedUrl(a: string, b: string): boolean {
	try {
		const x = new URL(a);
		const y = new URL(b);
		return x.origin === y.origin && x.pathname === y.pathname;
	} catch {
		return a === b;
	}
}

function hostOf(src: string): string {
	try {
		return new URL(src).host;
	} catch {
		return src;
	}
}

type FrameProps = {
	src: string;
	raw: string;
	title: string;
	style?: CSSProperties;
};

function RemoteFrame({
	src,
	raw,
	title,
	style,
	onLoad,
}: FrameProps & { onLoad?: () => void }) {
	const allow = readIframeAttr(raw, "allow") ?? undefined;
	const referrerPolicy = (readIframeAttr(raw, "referrerpolicy") ??
		"strict-origin-when-cross-origin") as React.HTMLAttributeReferrerPolicy;
	return (
		<iframe
			className="hubble-remote-embed-frame"
			src={src}
			title={title}
			sandbox={REMOTE_EMBED_SANDBOX}
			allow={allow}
			allowFullScreen={readIframeAttr(raw, "allowfullscreen") !== null}
			referrerPolicy={referrerPolicy}
			loading="lazy"
			style={style}
			onLoad={onLoad}
		/>
	);
}

export function RemoteEmbedView({
	node,
	selected,
	updateAttributes,
	editor,
}: Pick<NodeViewProps, "node" | "selected" | "updateAttributes" | "editor">) {
	const src = String(node.attrs.src ?? "");
	const raw = typeof node.attrs.raw === "string" ? node.attrs.raw : "";
	const title =
		readIframeAttr(raw, "title") || `${hostOf(src)} embed` || "Embed";
	const height = embedHeightPx(node.attrs.height);
	const portalContainer = usePortalContainer();
	const [dragHeight, setDragHeight] = useState<number | null>(null);
	const dragRef = useRef<{ y: number; height: number } | null>(null);
	const [reloadKey, setReloadKey] = useState(0);
	const [failure, setFailure] = useState<string | null>(null);
	const [fullScreen, setFullScreen] = useState(false);

	useEffect(() => {
		void reloadKey;
		setFailure(
			typeof navigator !== "undefined" && navigator.onLine === false
				? "You are offline."
				: null,
		);
		return desktopApi.onEmbedLoadFailed?.((event) => {
			if (sameEmbedUrl(event.url, src)) {
				setFailure(event.errorDescription || "The page refused to load.");
			}
		});
	}, [src, reloadKey]);

	const openInBrowser = () => {
		void desktopApi.openExternalUrl(src).catch(() => {
			toast.error("Failed to open in browser");
		});
	};
	const copyUrl = async () => {
		try {
			await navigator.clipboard.writeText(src);
			toast.success("Copied embed URL");
		} catch {
			toast.error("Failed to copy URL");
		}
	};

	const onResizeDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		dragRef.current = { y: event.clientY, height };
		setDragHeight(height);
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const onResizeMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		setDragHeight(
			Math.round(
				Math.min(
					MAX_HEIGHT,
					Math.max(MIN_HEIGHT, drag.height + event.clientY - drag.y),
				),
			),
		);
	};
	const onResizeUp = () => {
		const drag = dragRef.current;
		dragRef.current = null;
		if (!drag) return;
		if (dragHeight !== null && dragHeight !== drag.height) {
			updateAttributes({ height: String(dragHeight) });
		}
		setDragHeight(null);
	};

	const frameHeight = dragHeight ?? height;

	return (
		<NodeViewWrapper
			as="div"
			className="hubble-embed hubble-remote-embed"
			data-drag-handle
			style={{ inlineSize: embedWidthCss(node.attrs.width) }}
		>
			<ContextMenu.Root>
				<ContextMenu.Trigger
					render={
						<div
							className={[
								"hubble-remote-embed-chrome",
								selected ? "is-selected" : "",
								dragHeight !== null ? "is-resizing" : "",
							]
								.filter(Boolean)
								.join(" ")}
						/>
					}
				>
					<div className="hubble-remote-embed-bar" contentEditable={false}>
						<MingcuteGlobeLine
							className="size-3.5 shrink-0"
							aria-hidden="true"
						/>
						<span className="truncate">{title}</span>
						<span className="hubble-remote-embed-host">{hostOf(src)}</span>
					</div>
					{failure ? (
						<div
							className="hubble-remote-embed-fallback"
							style={{ blockSize: `${frameHeight}px` }}
						>
							<strong>{title}</strong>
							<span className="hubble-remote-embed-url">{src}</span>
							<span className="hubble-remote-embed-reason">
								Couldn't load this embed. {failure}
							</span>
							<button type="button" onClick={openInBrowser}>
								Open in browser
							</button>
						</div>
					) : (
						<RemoteFrame
							key={reloadKey}
							src={src}
							raw={raw}
							title={title}
							style={{ blockSize: `${frameHeight}px` }}
						/>
					)}
					{editor.isEditable ? (
						<span
							className="hubble-remote-embed-resize"
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
								onClick={() => setFullScreen(true)}
							>
								<MingcuteFullscreenLine
									className="size-3.5"
									aria-hidden="true"
								/>
								View full screen
							</ContextMenu.Item>
							<ContextMenu.Item
								className={MENU_ITEM_CLASS}
								onClick={() => void copyUrl()}
							>
								<MingcuteCopy2Line className="size-3.5" aria-hidden="true" />
								Copy URL
							</ContextMenu.Item>
							<ContextMenu.Item
								className={MENU_ITEM_CLASS}
								onClick={openInBrowser}
							>
								<MingcuteExternalLinkLine
									className="size-3.5"
									aria-hidden="true"
								/>
								Open in browser
							</ContextMenu.Item>
							<ContextMenu.Item
								className={MENU_ITEM_CLASS}
								onClick={() => setReloadKey((k) => k + 1)}
							>
								<MingcuteRefresh2Line className="size-3.5" aria-hidden="true" />
								Reload
							</ContextMenu.Item>
						</ContextMenu.Popup>
					</ContextMenu.Positioner>
				</ContextMenu.Portal>
			</ContextMenu.Root>
			<Dialog.Root open={fullScreen} onOpenChange={setFullScreen}>
				<Dialog.Portal container={portalContainer}>
					<Dialog.Backdrop className="fixed inset-0 z-40 bg-black/50" />
					<Dialog.Popup
						className="hubble-remote-embed-viewer fixed inset-4 z-50 flex flex-col overflow-hidden rounded-xl bg-background text-foreground shadow-overlay outline-hidden"
						data-remote-embed-viewer
					>
						<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
							<Dialog.Title className="m-0 me-auto truncate text-sm font-semibold">
								{title}
							</Dialog.Title>
							<button
								type="button"
								className="flex items-center gap-1 rounded-mdly-control px-2 py-1 text-xs hover:bg-accent"
								onClick={openInBrowser}
							>
								<MingcuteExternalLinkLine
									className="size-3.5"
									aria-hidden="true"
								/>
								Open in browser
							</button>
							<Dialog.Close
								aria-label="Close"
								className="rounded-mdly-control p-1 hover:bg-accent"
							>
								<MingcuteCloseLine className="size-4" aria-hidden="true" />
							</Dialog.Close>
						</div>
						{fullScreen ? (
							<RemoteFrame
								src={src}
								raw={raw}
								title={title}
								style={{ flex: "1 1 auto", blockSize: "auto" }}
							/>
						) : null}
					</Dialog.Popup>
				</Dialog.Portal>
			</Dialog.Root>
		</NodeViewWrapper>
	);
}
