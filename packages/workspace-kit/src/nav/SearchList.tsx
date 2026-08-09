import {
	forwardRef,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useCallback,
	useId,
	useRef,
} from "react";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import { cn } from "../lib/utils";
import { Input } from "../primitives/input";
import type { SidebarSearchResult } from "./buildSearchResults";
import { useSidebarKeyboardNav } from "./useSidebarKeyboardNav";
import { useVirtualSidebarRows } from "./useVirtualSidebarRows";

/**
 * The three keys the query box hands to the result list instead of treating as
 * text entry. Deliberately excludes Space and the horizontal arrows -- inside
 * an input those belong to the caret.
 */
const SEARCH_NAV_KEYS = ["ArrowDown", "ArrowUp", "Enter"] as const;

/**
 * Query box over a ranked, flat result list. Quick-open only, like
 * `RecentFilesList` -- no rename/delete/pin/drag here.
 *
 * The query is host-owned (`query` + `onQueryChange`) rather than local state,
 * because in every host that wants this page the same string already drives
 * something else on screen -- SpeechToDo filters its centre list with it. Two
 * copies of one query is a desync waiting to happen.
 *
 * Forwards a ref to the INPUT, not to the scroll container as the sibling
 * lists do: switching to this page should put the caret where the user is
 * about to type, which also gives hosts a "focus the search box" affordance
 * through `Sidebar`'s `showPage` handle without page state leaving the kit.
 */
export const SearchList = forwardRef<
	HTMLInputElement,
	{
		results: readonly SidebarSearchResult[];
		query: string;
		onQueryChange: (query: string) => void;
		currentPath: string | null;
		onSelectFile: (path: string) => void;
		/** Host-supplied so an app that ships more than one language can translate it. */
		placeholder?: string;
		/** Trailing slot in the query box, e.g. the host's own shortcut chip. */
		hint?: ReactNode;
		/** Shown when a non-empty query matches nothing. */
		emptyState?: ReactNode;
	}
>(function SearchList(
	{
		results,
		query,
		onQueryChange,
		currentPath,
		onSelectFile,
		placeholder,
		hint,
		emptyState,
	},
	forwardedRef,
) {
	const listRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const setInputRef = useCallback(
		(node: HTMLInputElement | null) => {
			inputRef.current = node;
			if (typeof forwardedRef === "function") forwardedRef(node);
			else if (forwardedRef) forwardedRef.current = node;
		},
		[forwardedRef],
	);
	const listId = useId();

	const activateFile = useCallback(
		(result: SidebarSearchResult) => onSelectFile(result.file.path),
		[onSelectFile],
	);

	const { focusedIndex, setFocusedIndex, onKeyDown } = useSidebarKeyboardNav({
		items: results as SidebarSearchResult[],
		onSelect: activateFile,
		// The rows scroll here; the keystrokes arrive from the box above.
		navRef: listRef,
		activeIndex: results.findIndex(
			(result) => result.file.path === currentPath,
		),
		editableKeys: SEARCH_NAV_KEYS,
	});

	const handleKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLInputElement>) => {
			// Escape empties the box first. Only on an already-empty box does it
			// fall through to the list's own "hand focus back to the editor"
			// behaviour, which would otherwise strand the user with a stale query
			// and no visible focus.
			if (event.key === "Escape" && query) {
				event.preventDefault();
				event.stopPropagation();
				onQueryChange("");
				setFocusedIndex(null);
				return;
			}
			onKeyDown(event);
		},
		[onKeyDown, onQueryChange, query, setFocusedIndex],
	);

	const handleChange = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			onQueryChange(event.target.value);
			// A new query means new rows; keeping the old highlighted index would
			// point at an unrelated file.
			setFocusedIndex(null);
		},
		[onQueryChange, setFocusedIndex],
	);

	const clearQuery = useCallback(() => {
		onQueryChange("");
		setFocusedIndex(null);
		inputRef.current?.focus();
	}, [onQueryChange, setFocusedIndex]);

	const virtualRows = useVirtualSidebarRows({
		rows: results as SidebarSearchResult[],
		scrollRef: listRef,
	});

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* mb-1 (not pb-1): padding would grow this box's own height, so the
			    hint/clear button -- centered against this box via top-1/2 --
			    would land off-center from the input's own vertical middle. A
			    margin adds the same visual gap above the results list without
			    affecting what "centered" means for the absolutely-positioned
			    children. */}
			<div className="relative mt-2 mb-1 shrink-0 px-2.5">
				<Input
					ref={setInputRef}
					data-sidebar-search
					variant="ghost"
					// Not type="search": the browser's own clear affordance can't be
					// styled to match, so the button below does that job instead.
					type="text"
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={results.length > 0}
					aria-controls={listId}
					aria-activedescendant={
						focusedIndex !== null ? `${listId}-o${focusedIndex}` : undefined
					}
					aria-label={placeholder ?? "Search files"}
					placeholder={placeholder ?? "Search files"}
					// The (optional) trailing hint/clear button is overlaid on top of
					// the input rather than laid out as a flex sibling, so it reads as
					// part of one text box instead of a control bracketing it. No
					// extra outline/ring classes here -- the ghost variant already
					// zeroes those, and re-stating "outline-none" would win a
					// tailwind-merge conflict against the base primitive's
					// "outline-hidden" and let the browser's native focus ring show
					// through instead of suppressing it.
					className="h-7 pr-9"
					value={query}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
				/>
				<div className="pointer-events-none absolute top-1/2 right-2.5 flex -translate-y-1/2 items-center">
					{query ? (
						<button
							type="button"
							aria-label="Clear search"
							className="pointer-events-auto flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 outline-hidden hover:bg-accent hover:text-muted-foreground"
							onClick={clearQuery}
						>
							<MingcuteCloseLine className="size-3" />
						</button>
					) : (
						hint
					)}
				</div>
			</div>
			<div
				ref={listRef}
				id={listId}
				role="listbox"
				aria-label="Search results"
				// No tabIndex: focus stays in the box, and the highlighted row is
				// announced through aria-activedescendant instead.
				className="flex-1 overflow-y-auto overscroll-contain px-1.5 py-1 outline-none"
			>
				{results.length === 0 ? (
					query ? (
						(emptyState ?? (
							<p className="px-2 py-3 text-[11px] text-muted-foreground">
								No matching files.
							</p>
						))
					) : (
						<p className="px-2 py-3 text-[11px] text-muted-foreground">
							Type to search this workspace.
						</p>
					)
				) : null}
				{virtualRows.paddingTop > 0 ? (
					<div aria-hidden="true" style={{ height: virtualRows.paddingTop }} />
				) : null}
				{virtualRows.items.map(({ row: result, index }) => {
					const isActive = result.file.path === currentPath;
					const isFocused = focusedIndex === index;
					return (
						<button
							key={result.file.path}
							type="button"
							role="option"
							id={`${listId}-o${index}`}
							data-sidebar-index={index}
							aria-selected={isActive}
							// Focus never leaves the query box; without this, Tab out of
							// the box would walk through every result.
							tabIndex={-1}
							title={result.displayPath}
							className={cn(
								"flex w-full min-w-0 items-center rounded-[var(--radius-row)] px-2 [padding-block:var(--row-pad-block)] text-start text-[length:var(--font-size-sidebar)] text-sidebar-foreground outline-hidden hover:bg-accent",
								!isActive && isFocused && "bg-accent",
								isActive &&
									"bg-sidebar-accent text-sidebar-accent-foreground font-medium",
							)}
							onClick={() => activateFile(result)}
						>
							<span className="min-w-0 flex-1 truncate">{result.label}</span>
						</button>
					);
				})}
				{virtualRows.paddingBottom > 0 ? (
					<div
						aria-hidden="true"
						style={{ height: virtualRows.paddingBottom }}
					/>
				) : null}
			</div>
		</div>
	);
});
