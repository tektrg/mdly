import {
	type KeyboardEvent as ReactKeyboardEvent,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

export type PeekListDividerProps = {
	splitRef: RefObject<HTMLElement | null>;
	/** The current rendered list width, for keyboard nudges. */
	listWidth: number;
	/** Receives the RAW pointer-derived width; the caller clamps + persists. */
	onResize: (listWidth: number) => void;
	onResizeStart?: () => void;
	onResizeEnd?: () => void;
};

const KEYBOARD_STEP = 16;

/**
 * Pointer position as a list width, direction-aware: the list sits at the
 * inline start, so in RTL the width grows toward decreasing clientX.
 */
export function listWidthFromPointer({
	clientX,
	splitRectLeft,
	splitRectRight,
	direction,
}: {
	clientX: number;
	splitRectLeft: number;
	splitRectRight: number;
	direction: string;
}): number {
	const raw =
		direction === "rtl" ? splitRectRight - clientX : clientX - splitRectLeft;
	return Math.max(0, raw);
}

function setResizingFlag(split: HTMLElement | null, resizing: boolean): void {
	if (!split) return;
	if (resizing) split.setAttribute("data-resizing", "");
	else split.removeAttribute("data-resizing");
}

/**
 * The draggable edge between the peek list and the open document. Dragging
 * reports pointer-derived widths; `clampPeekListWidth` (R13) stays the
 * caller's job so the divider never learns the document floor itself.
 */
export function PeekListDivider({
	splitRef,
	listWidth,
	onResize,
	onResizeStart,
	onResizeEnd,
}: PeekListDividerProps) {
	const [dragging, setDragging] = useState(false);
	const dragState = useRef(false);

	const endDrag = useCallback(() => {
		if (!dragState.current) return;
		dragState.current = false;
		setDragging(false);
		setResizingFlag(splitRef.current, false);
		onResizeEnd?.();
	}, [splitRef, onResizeEnd]);

	useEffect(() => {
		if (!dragging) return;
		const onMove = (event: MouseEvent) => {
			const split = splitRef.current;
			if (!split) return;
			const rect = split.getBoundingClientRect();
			const direction =
				typeof window === "undefined"
					? "ltr"
					: window.getComputedStyle(split).direction;
			onResize(
				listWidthFromPointer({
					clientX: event.clientX,
					splitRectLeft: rect.left,
					splitRectRight: rect.right,
					direction,
				}),
			);
		};
		const onUp = () => endDrag();
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
	}, [dragging, splitRef, onResize, endDrag]);

	const beginDrag = useCallback(
		(event: { preventDefault: () => void }) => {
			event.preventDefault();
			dragState.current = true;
			setDragging(true);
			setResizingFlag(splitRef.current, true);
			onResizeStart?.();
		},
		[splitRef, onResizeStart],
	);

	const onKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLElement>) => {
			const split = splitRef.current;
			const direction =
				split && typeof window !== "undefined"
					? window.getComputedStyle(split).direction
					: "ltr";
			const rtl = direction === "rtl";
			let delta = 0;
			if (event.key === "ArrowRight")
				delta = rtl ? -KEYBOARD_STEP : KEYBOARD_STEP;
			else if (event.key === "ArrowLeft")
				delta = rtl ? KEYBOARD_STEP : -KEYBOARD_STEP;
			else return;
			event.preventDefault();
			onResize(Math.max(0, listWidth + delta));
		},
		[splitRef, listWidth, onResize],
	);

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize document list"
			aria-valuenow={Math.round(listWidth)}
			tabIndex={0}
			data-peek-list-divider
			data-dragging={dragging ? "" : undefined}
			className="relative z-10 flex shrink-0 cursor-ew-resize touch-none items-stretch justify-center outline-hidden [inline-size:0.75rem] [margin-inline:-0.375rem] focus-visible:ring-1 focus-visible:ring-ring"
			onMouseDown={beginDrag}
			onKeyDown={onKeyDown}
		>
			<span
				aria-hidden="true"
				className="self-stretch bg-border [inline-size:1px]"
			/>
		</div>
	);
}
