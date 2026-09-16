import { Input } from "@mdly/workspace-kit";
import { type KeyboardEvent as ReactKeyboardEvent, useRef } from "react";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import MingcuteSearchLine from "~icons/mingcute/search-line";
import { cn } from "../lib/utils";

/**
 * Filter box for both densities. Always rendered *outside* the row scroll
 * container, so a filter that matches nothing never unmounts it — the text and
 * the caret survive (O16).
 */
export function DocumentFilterInput({
	value,
	onChange,
	className,
}: {
	value: string;
	onChange: (filter: string) => void;
	className?: string;
}) {
	const inputRef = useRef<HTMLInputElement>(null);

	function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
		// Escape empties the box before anything upstream reads it as "leave this
		// document"; an empty box falls through to the app's own Escape owners.
		if (event.key === "Escape" && value.length > 0) {
			event.preventDefault();
			event.stopPropagation();
			onChange("");
		}
	}

	return (
		<div className={cn("relative", className)}>
			<MingcuteSearchLine
				aria-hidden="true"
				className="pointer-events-none absolute start-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/70"
			/>
			<Input
				ref={inputRef}
				// Not type="search": the browser's own clear affordance cannot be
				// styled to match, so the button below does that job instead.
				type="text"
				aria-label="Filter documents"
				placeholder="Filter documents"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={onKeyDown}
				className="h-7 w-full ps-7 pe-7 text-[length:var(--font-size-sidebar)]"
			/>
			{value.length > 0 ? (
				<button
					type="button"
					aria-label="Clear filter"
					className="absolute end-1.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground/70 outline-hidden transition-colors duration-150 ease-snappy hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none"
					onClick={() => {
						onChange("");
						inputRef.current?.focus();
					}}
				>
					<MingcuteCloseLine className="size-3" />
				</button>
			) : null}
		</div>
	);
}
