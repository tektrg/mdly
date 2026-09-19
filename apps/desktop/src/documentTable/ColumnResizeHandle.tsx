/**
 * Right-edge handle for resizing one document-table header column.
 * Double-click resets that column to automatic width. Mouse-only affordance:
 * keyboard users reorder with Alt+Arrow on the header instead.
 */
export function ColumnResizeHandle({
	onResizeStart,
	onResizeMove,
	onResizeEnd,
	onReset,
}: {
	onResizeStart: (clientX: number, startWidth: number) => void;
	onResizeMove: (clientX: number) => void;
	onResizeEnd: () => void;
	onReset: () => void;
}) {
	return (
		<span
			data-resize-handle
			title="Drag to resize (double-click resets)"
			aria-hidden="true"
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				onResizeStart(
					event.clientX,
					event.currentTarget.parentElement?.offsetWidth ?? 80,
				);
			}}
			onPointerMove={(event) => {
				if (event.buttons > 0) onResizeMove(event.clientX);
			}}
			onPointerUp={() => onResizeEnd()}
			onPointerCancel={() => onResizeEnd()}
			onDoubleClick={(event) => {
				event.stopPropagation();
				onReset();
			}}
			className="absolute inset-y-0 end-0 w-3 cursor-col-resize touch-none"
		>
			<span
				aria-hidden="true"
				className="absolute inset-y-1 end-0.5 w-px bg-primary opacity-0 group-hover:opacity-100"
			/>
		</span>
	);
}
