import { Dialog } from "@base-ui/react/dialog";
import {
	lazy,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import MingcuteAddLine from "~icons/mingcute/add-line";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import MingcuteEdit2Line from "~icons/mingcute/edit-2-line";
import MingcuteFullscreenLine from "~icons/mingcute/fullscreen-line";
import MingcuteLeftLine from "~icons/mingcute/left-line";
import MingcuteMinimizeLine from "~icons/mingcute/minimize-line";
import MingcuteRightLine from "~icons/mingcute/right-line";
import { usePortalContainer } from "../lib/portalContainer";
import { Button } from "../primitives/button";

const MermaidDiagram = lazy(() =>
	import("@tektrg/diagram-kit/react").then((module) => ({
		default: module.MermaidDiagram,
	})),
);

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

export function clampZoom(zoom: number): number {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	source: string;
	onEdit: () => void;
};

/** Full-screen Mermaid diagram viewer (zoom/pan via ZoomViewer). */
export function MermaidViewer({ open, onOpenChange, source, onEdit }: Props) {
	return (
		<ZoomViewer
			open={open}
			onOpenChange={onOpenChange}
			title="Diagram"
			actions={
				<Button type="button" variant="ghost" size="sm" onClick={onEdit}>
					<MingcuteEdit2Line />
					Edit code
				</Button>
			}
		>
			<Suspense fallback={null}>
				<MermaidDiagram source={source} className="pm-mermaid-viewer-diagram" />
			</Suspense>
		</ZoomViewer>
	);
}

export type ZoomViewerProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: ReactNode;
	/** Extra toolbar buttons, shown before Close. */
	actions?: ReactNode;
	/** Step to the previous/next item (Left/Right arrows + toolbar buttons). */
	onPrevious?: () => void;
	onNext?: () => void;
	/** Changing it resets zoom to fit (e.g. when stepping between images). */
	contentKey?: string;
	children: ReactNode;
};

/**
 * Full-screen zoom/pan viewer shared by diagrams and images. Zoom 1 = "fit":
 * the content is contained in the viewport. Higher/lower zoom resizes the
 * stage to a multiple of the viewport and the scroll container pans it
 * (drag, scrollbars, trackpad).
 */
export function ZoomViewer({
	open,
	onOpenChange,
	title,
	actions,
	onPrevious,
	onNext,
	contentKey,
	children,
}: ZoomViewerProps) {
	const portalContainer = usePortalContainer();
	const [zoom, setZoom] = useState(1);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	// Pointer position (relative to the scroll box) + the zoom ratio to keep
	// under the cursor; applied after the resized box has laid out.
	const anchorRef = useRef<{ x: number; y: number; ratio: number } | null>(
		null,
	);
	const dragRef = useRef<{
		x: number;
		y: number;
		left: number;
		top: number;
	} | null>(null);

	useEffect(() => {
		void contentKey;
		if (open) setZoom(1);
	}, [open, contentKey]);

	const zoomBy = useCallback(
		(factor: number, at?: { x: number; y: number }) => {
			setZoom((current) => {
				const next = clampZoom(current * factor);
				if (next === current) return current;
				const box = scrollRef.current;
				anchorRef.current = {
					x: at?.x ?? (box ? box.clientWidth / 2 : 0),
					y: at?.y ?? (box ? box.clientHeight / 2 : 0),
					ratio: next / current,
				};
				return next;
			});
		},
		[],
	);

	useLayoutEffect(() => {
		// `zoom` is the trigger; the anchor ref carries the pointer position.
		void zoom;
		const anchor = anchorRef.current;
		const box = scrollRef.current;
		anchorRef.current = null;
		if (!anchor || !box) return;
		box.scrollLeft = (box.scrollLeft + anchor.x) * anchor.ratio - anchor.x;
		box.scrollTop = (box.scrollTop + anchor.y) * anchor.ratio - anchor.y;
	}, [zoom]);

	// React's onWheel is passive, so pinch/ctrl-wheel zoom needs a native
	// non-passive listener to stop the page itself from zooming. The scroll box
	// only mounts once the dialog portal opens, so re-attach on `open`.
	useEffect(() => {
		const box = scrollRef.current;
		if (!open || !box) return;
		const onWheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			const rect = box.getBoundingClientRect();
			zoomBy(Math.exp(-event.deltaY * 0.01), {
				x: event.clientX - rect.left,
				y: event.clientY - rect.top,
			});
		};
		box.addEventListener("wheel", onWheel, { passive: false });
		return () => box.removeEventListener("wheel", onWheel);
	});

	const onKeyDown = (event: React.KeyboardEvent) => {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === "+" || event.key === "=") {
			event.preventDefault();
			zoomBy(ZOOM_STEP);
		} else if (event.key === "-") {
			event.preventDefault();
			zoomBy(1 / ZOOM_STEP);
		} else if (event.key === "0") {
			event.preventDefault();
			setZoom(1);
		} else if (event.key === "ArrowLeft" && onPrevious) {
			event.preventDefault();
			onPrevious();
		} else if (event.key === "ArrowRight" && onNext) {
			event.preventDefault();
			onNext();
		}
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		const box = scrollRef.current;
		if (!box || event.button !== 0) return;
		dragRef.current = {
			x: event.clientX,
			y: event.clientY,
			left: box.scrollLeft,
			top: box.scrollTop,
		};
		box.setPointerCapture(event.pointerId);
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		const box = scrollRef.current;
		if (!drag || !box) return;
		box.scrollLeft = drag.left - (event.clientX - drag.x);
		box.scrollTop = drag.top - (event.clientY - drag.y);
	};
	const endDrag = () => {
		dragRef.current = null;
	};

	const percent = Math.round(zoom * 100);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal container={portalContainer}>
				<Dialog.Popup
					className="fixed inset-0 z-50 flex flex-col bg-background text-foreground outline-hidden"
					data-mermaid-viewer
					onKeyDown={onKeyDown}
				>
					<div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
						<Dialog.Title className="m-0 me-auto truncate text-sm font-semibold">
							{title}
						</Dialog.Title>
						{onPrevious || onNext ? (
							<>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label="Previous"
									title="Previous (←)"
									disabled={!onPrevious}
									onClick={onPrevious}
								>
									<MingcuteLeftLine />
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label="Next"
									title="Next (→)"
									disabled={!onNext}
									onClick={onNext}
								>
									<MingcuteRightLine />
								</Button>
							</>
						) : null}
						<Dialog.Description className="sr-only">
							Zoom with the buttons, + and -, or pinch. Drag to pan. Press 0 to
							fit.
						</Dialog.Description>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label="Zoom out"
							title="Zoom out (-)"
							disabled={zoom <= MIN_ZOOM}
							onClick={() => zoomBy(1 / ZOOM_STEP)}
						>
							<MingcuteMinimizeLine />
						</Button>
						<span
							className="min-w-12 text-center text-xs tabular-nums text-muted-foreground"
							data-mermaid-zoom
							aria-live="polite"
						>
							{percent}%
						</span>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label="Zoom in"
							title="Zoom in (+)"
							disabled={zoom >= MAX_ZOOM}
							onClick={() => zoomBy(ZOOM_STEP)}
						>
							<MingcuteAddLine />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label="Fit to screen"
							title="Fit to screen (0)"
							onClick={() => setZoom(1)}
						>
							<MingcuteFullscreenLine />
						</Button>
						{actions}
						<Dialog.Close
							render={
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label="Close"
									title="Close (Esc)"
								/>
							}
						>
							<MingcuteCloseLine />
						</Dialog.Close>
					</div>
					<div
						ref={scrollRef}
						className="pm-mermaid-viewer-scroll min-h-0 flex-1 overflow-auto"
						data-zoomed={zoom !== 1}
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onPointerUp={endDrag}
						onPointerCancel={endDrag}
					>
						<div
							className="pm-mermaid-viewer-stage"
							style={{
								inlineSize: `${zoom * 100}%`,
								blockSize: `${zoom * 100}%`,
							}}
						>
							{children}
						</div>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
