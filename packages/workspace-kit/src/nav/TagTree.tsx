import {
	type Ref,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import MingcuteRightLine from "~icons/mingcute/right-line";
import { fileNameFromPath } from "../lib/filePath";
import { cn } from "../lib/utils";
import {
	buildTagTree,
	flattenTagTree,
	groupFilesByTag,
	tagGroupAncestors,
	type FlatTagTreeRow,
} from "./buildTagTree";
import type { TagListProps } from "./TagList";
import { useSidebarKeyboardNav } from "./useSidebarKeyboardNav";
import {
	readExpandedIdSet,
	type SidebarFile,
	compareFiles,
	writeExpandedIdSet,
} from "./useSidebarTree";
import { useVirtualSidebarRows } from "./useVirtualSidebarRows";

const NO_FILES: readonly SidebarFile[] = [];

/**
 * Hierarchical Tags page: namespaces nest series, and expanding a leaf tag
 * reveals the files carrying it inline — mirroring how the Documents page's
 * folder tree reveals files under folders. Rendered only when the host opts
 * in with `tagSeparator`; the flat `TagList` below stays the default.
 *
 * Semantics-free like the flat list: nesting splits on the separator verbatim
 * (no title-casing, no namespace knowledge), group labels/icons come from the
 * host's `formatGroupLabel`/`renderGroupIcon`, and leaf rows keep the flat
 * list's `renderIcon`/`formatLabel`. Selection-only — no rename/delete/merge
 * affordances — with the same keyboard nav and virtualization as the flat list.
 */
export function TagTreeView({
	tags,
	activeTag,
	onSelect,
	renderIcon,
	formatLabel,
	emptyState,
	tagSeparator = "",
	formatGroupLabel,
	renderGroupIcon,
	files = NO_FILES,
	getFileDisplayPath = (path) => path,
	onSelectFile,
	activeFilePath = null,
	storageScope,
	forwardedRef,
	sortMode = "alpha",
}: TagListProps & {
	forwardedRef: Ref<HTMLDivElement>;
}) {
	const navRef = useRef<HTMLDivElement>(null);
	const setNavRef = useCallback(
		(node: HTMLDivElement | null) => {
			navRef.current = node;
			if (typeof forwardedRef === "function") forwardedRef(node);
			else if (forwardedRef) forwardedRef.current = node;
		},
		[forwardedRef],
	);

	// Expansion persists per workspace like folder expansion does, under its
	// own key so the two trees never collide.
	const storageKey = storageScope
		? `hubble-sidebar-expanded-tags:${storageScope}`
		: null;
	const [expandedState, setExpandedState] = useState(() => ({
		key: storageKey,
		ids: readExpandedIdSet(storageKey),
	}));
	const expandedIds =
		expandedState.key === storageKey ? expandedState.ids : new Set<string>();

	useEffect(() => {
		setExpandedState({
			key: storageKey,
			ids: readExpandedIdSet(storageKey),
		});
	}, [storageKey]);

	useEffect(() => {
		if (expandedState.key !== storageKey) return;
		writeExpandedIdSet(storageKey, expandedState.ids);
	}, [storageKey, expandedState]);

	const tree = useMemo(
		() => buildTagTree(tags, tagSeparator, files),
		[tags, tagSeparator, files],
	);
	const sortedFilesByTag = useMemo(() => {
		const grouped = groupFilesByTag(files);
		const sorted = new Map<string, SidebarFile[]>();
		for (const [name, list] of grouped) {
			// Same comparator as the folder tree, so the nav sort toggle
			// (Name/Recent) moves tag-inline files exactly like folder files.
			sorted.set(name, [...list].sort((a, b) => compareFiles(a, b, sortMode)));
		}
		return sorted;
	}, [files, sortMode]);
	const rows = useMemo(
		() => flattenTagTree(tree, expandedIds, sortedFilesByTag),
		[tree, expandedIds, sortedFilesByTag],
	);

	// Reveal the active tag's path like the folder tree reveals its highlight.
	useEffect(() => {
		if (!activeTag) return;
		const ids = [...tagGroupAncestors(activeTag, tagSeparator), activeTag];
		setExpandedState((current) => {
			const next = new Set(
				current.key === storageKey
					? current.ids
					: readExpandedIdSet(storageKey),
			);
			let changed = false;
			for (const id of ids) {
				if (next.has(id)) continue;
				next.add(id);
				changed = true;
			}
			return changed ? { key: storageKey, ids: next } : current;
		});
	}, [activeTag, tagSeparator, storageKey]);

	const setExpanded = useCallback(
		(id: string, expanded: boolean) => {
			setExpandedState((current) => {
				const next = new Set(
					current.key === storageKey
						? current.ids
						: readExpandedIdSet(storageKey),
				);
				if (expanded) next.add(id);
				else next.delete(id);
				return { key: storageKey, ids: next };
			});
		},
		[storageKey],
	);
	const toggleRow = useCallback(
		(row: FlatTagTreeRow) => {
			if (row.kind === "group") setExpanded(row.id, !row.expanded);
			else if (row.kind === "tag") setExpanded(row.tag.name, !row.expanded);
		},
		[setExpanded],
	);

	const activateRow = useCallback(
		(row: FlatTagTreeRow) => {
			if (row.kind === "file") {
				onSelectFile?.(row.file.path);
				return;
			}
			// A group that is also an exact tag selects it, then expands like
			// any group; a leaf selects and reveals its files inline.
			if (row.kind === "group" && row.tagName) onSelect(row.tagName);
			if (row.kind === "tag") onSelect(row.tag.name);
			toggleRow(row);
		},
		[onSelect, onSelectFile, toggleRow],
	);
	const expandRow = useCallback(
		(row: FlatTagTreeRow) => {
			if (row.kind === "group") setExpanded(row.id, true);
			else if (row.kind === "tag") setExpanded(row.tag.name, true);
		},
		[setExpanded],
	);
	const collapseRow = useCallback(
		(row: FlatTagTreeRow) => {
			if (row.kind === "group") setExpanded(row.id, false);
			else if (row.kind === "tag") setExpanded(row.tag.name, false);
		},
		[setExpanded],
	);

	const activeIndex = rows.findIndex((row) =>
		row.kind === "file"
			? false
			: row.kind === "group"
				? row.tagName === activeTag
				: row.tag.name === activeTag,
	);
	const { focusedIndex, onKeyDown } = useSidebarKeyboardNav({
		items: rows,
		onSelect: activateRow,
		onExpand: expandRow,
		onCollapse: collapseRow,
		navRef,
		activeIndex,
	});

	const virtualRows = useVirtualSidebarRows({
		rows,
		scrollRef: navRef,
	});

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div
				ref={setNavRef}
				role="listbox"
				aria-label="Tags"
				className="flex-1 overflow-y-auto overscroll-contain px-1.5 py-1 outline-none"
				tabIndex={0}
				onKeyDown={onKeyDown}
			>
				{tags.length === 0
					? (emptyState ?? (
							<p className="px-2 py-3 text-[11px] text-muted-foreground">
								No tags yet.
							</p>
						))
					: null}
				{virtualRows.paddingTop > 0 ? (
					<div aria-hidden="true" style={{ height: virtualRows.paddingTop }} />
				) : null}
				{virtualRows.items.map(({ row, index }) => {
					const depthStyle = {
						paddingInlineStart: `calc(0.5rem + ${row.depth * 0.75}rem)`,
					} as React.CSSProperties;
					if (row.kind === "file") {
						const displayPath = getFileDisplayPath(row.file.path);
						const isActive = row.file.path === activeFilePath;
						const isFocused = focusedIndex === index;
						return (
							<button
								key={`${row.parentTag}:${row.file.path}`}
								type="button"
								role="option"
								data-sidebar-index={index}
								data-tag-file={row.parentTag}
								aria-selected={isActive}
								title={displayPath}
								className={cn(
									"flex w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-row)] pe-2 text-start text-[length:var(--font-size-sidebar)] text-sidebar-foreground outline-hidden [padding-block:var(--row-pad-block)] hover:bg-accent",
									!isActive && isFocused && "bg-accent",
									isActive &&
										"bg-sidebar-accent text-sidebar-accent-foreground font-medium",
								)}
								style={depthStyle}
								onClick={() => onSelectFile?.(row.file.path)}
							>
								<span className="min-w-0 flex-1 truncate">
									{fileNameFromPath(displayPath)}
								</span>
							</button>
						);
					}
					const isActive =
						row.kind === "group"
							? row.tagName !== null && row.tagName === activeTag
							: row.tag.name === activeTag;
					const isFocused = focusedIndex === index;
					const label =
						row.kind === "group"
							? (formatGroupLabel?.(row.fullPath) ?? row.segment)
							: // Tree leaves default to their own segment ("aptus",
							// not "team/aptus") — the namespace is already on the
							// parent row. The host's formatLabel still wins when
							// given, so flat-list formatting is untouched.
							(formatLabel?.(row.tag.name) ?? row.segment);
					const icon =
						row.kind === "group"
							? renderGroupIcon?.(row.fullPath)
							: renderIcon?.(row.tag.name);
					const rowKey = row.kind === "group" ? row.id : row.tag.name;
					return (
						<button
							key={rowKey}
							type="button"
							role="option"
							data-sidebar-index={index}
							data-tag-group={row.kind === "group" ? row.fullPath : undefined}
							data-tag-leaf={row.kind === "tag" ? row.tag.name : undefined}
							aria-selected={isActive}
							aria-expanded={row.expanded}
							title={label}
							className={cn(
								"flex w-full min-w-0 items-center gap-1.5 rounded-[var(--radius-row)] pe-2 text-start text-[length:var(--font-size-sidebar)] text-sidebar-foreground outline-hidden [padding-block:var(--row-pad-block)] hover:bg-accent",
								!isActive && isFocused && "bg-accent",
								isActive &&
									"bg-sidebar-accent text-sidebar-accent-foreground font-medium",
							)}
							style={depthStyle}
							onClick={() => activateRow(row)}
						>
							<span
								className="inline-flex size-3 shrink-0 items-center justify-center text-muted-foreground"
								data-sidebar-chevron
							>
								<MingcuteRightLine
									className={cn(
										"size-3 transition-transform duration-150 ease-out",
										row.expanded && "rotate-90",
									)}
								/>
							</span>
							{icon ? (
								<span className="flex shrink-0 items-center">{icon}</span>
							) : null}
							<span className="min-w-0 flex-1 truncate">{label}</span>
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
}
