import { Input } from "@mdly/workspace-kit";
import { keymatch } from "keymatch";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useEffect,
	useRef,
} from "react";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import MingcuteSearchLine from "~icons/mingcute/search-line";
import { livePatternMode } from "../lib/patternHint";
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
	// `*` or `/…/` switches the box to path-pattern mode; say so, and flag a
	// regex that does not compile instead of silently matching nothing.
	const mode = livePatternMode(value);

	// Cmd/Ctrl+L focuses the box from anywhere (editor, sidebar, rows), browser
	// address-bar style. Mounted only while the table/list is on screen, so the
	// shortcut is inert elsewhere.
	useEffect(() => {
		const onWindowKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || !keymatch(event, "CmdOrCtrl+L")) return;
			const input = inputRef.current;
			if (!input) return;
			event.preventDefault();
			input.focus();
			input.select();
		};
		window.addEventListener("keydown", onWindowKeyDown);
		return () => window.removeEventListener("keydown", onWindowKeyDown);
	}, []);

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
				aria-invalid={mode === "invalid" || undefined}
				aria-describedby={mode === "plain" ? undefined : "document-filter-mode"}
				title={
					mode === "plain"
						? undefined
						: "Path pattern on folder/file.md · * = anything · /…/ = regex · commas = or"
				}
				placeholder="Filter documents"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={onKeyDown}
				className={cn(
					"h-8 w-full rounded-full ps-7 text-[length:var(--font-size-sidebar)] bg-mdly-control focus-visible:ring-[3px] focus-visible:ring-mdly-ink/[0.07]",
					mode === "plain" ? "pe-7" : "pe-[4.5rem]",
				)}
			/>
			{mode !== "plain" ? (
				<span
					id="document-filter-mode"
					className={cn(
						"pointer-events-none absolute end-7 top-1/2 -translate-y-1/2 text-[10px]",
						mode === "invalid"
							? "text-destructive"
							: "text-muted-foreground/80",
					)}
				>
					{mode === "invalid" ? "invalid pattern" : "pattern"}
				</span>
			) : null}
			{value.length > 0 ? (
				<button
					type="button"
					aria-label="Clear filter"
					className="absolute end-1.5 top-1/2 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground/70 outline-hidden transition-colors duration-150 ease-snappy hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-mdly-ink/20 motion-reduce:transition-none"
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
