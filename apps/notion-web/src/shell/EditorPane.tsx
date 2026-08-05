import { Button, EditorView } from "@mdly/workspace-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import MingcuteLayoutLeftLine from "~icons/mingcute/layout-left-line";
import MingcuteMore2Line from "~icons/mingcute/more-2-line";
import MingcuteSearchLine from "~icons/mingcute/search-line";
import { pushPage, saveDraft } from "../notion/pageSync";
import { comparableContentHash, type Draft } from "../store/drafts";

type Message = { text: string; type: "success" | "error" } | null;

type Props = {
	draft: Draft;
	conflict: boolean;
	onDirtyChange: (pageId: string, dirty: boolean) => void;
	onPushed: (draft: Draft) => void;
	onTakeRemote: () => void;
	onOpenMenu: () => void;
	onOpenSearch: () => void;
};

export function EditorPane({
	draft,
	conflict,
	onDirtyChange,
	onPushed,
	onTakeRemote,
	onOpenMenu,
	onOpenSearch,
}: Props) {
	const latestMarkdownRef = useRef(draft.markdown);
	const [dirty, setDirty] = useState(
		() => comparableContentHash(draft.markdown) !== draft.syncedContentHash,
	);
	const [pushing, setPushing] = useState(false);
	const [message, setMessage] = useState<Message>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const menuButtonRef = useRef<HTMLButtonElement | null>(null);
	const menuPanelRef = useRef<HTMLDivElement | null>(null);
	const [headerHidden, setHeaderHidden] = useState(false);
	const lastScrollTopRef = useRef(0);
	const contentRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!menuOpen) return;
		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (
				!menuButtonRef.current?.contains(target) &&
				!menuPanelRef.current?.contains(target)
			) {
				setMenuOpen(false);
			}
		};
		document.addEventListener("pointerdown", handlePointerDown);
		return () => document.removeEventListener("pointerdown", handlePointerDown);
	}, [menuOpen]);

	// The header can scroll out of view (see below); don't leave the menu
	// floating with no visible anchor once that happens.
	useEffect(() => {
		if (headerHidden) setMenuOpen(false);
	}, [headerHidden]);

	useEffect(() => {
		const contentEl = contentRef.current;
		if (!contentEl) return;
		// Scroll events don't bubble, but they do reach ancestors registered
		// with `capture: true` — this fires regardless of which descendant
		// (the editor's own internal viewport) actually scrolled.
		const handleScroll = (event: Event) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			const scrollTop = target.scrollTop;
			const delta = scrollTop - lastScrollTopRef.current;
			lastScrollTopRef.current = scrollTop;
			if (scrollTop <= 0 || delta < -4) {
				setHeaderHidden(false);
			} else if (delta > 4) {
				setHeaderHidden(true);
			}
		};
		contentEl.addEventListener("scroll", handleScroll, {
			capture: true,
			passive: true,
		});
		return () =>
			contentEl.removeEventListener("scroll", handleScroll, { capture: true });
	}, []);

	// Reset local view state when switching pages.
	useEffect(() => {
		latestMarkdownRef.current = draft.markdown;
		setDirty(comparableContentHash(draft.markdown) !== draft.syncedContentHash);
		setMessage(null);
	}, [draft.pageId, draft.markdown, draft.syncedContentHash]);

	const recomputeDirty = useCallback(
		(markdown: string) => {
			const next = comparableContentHash(markdown) !== draft.syncedContentHash;
			setDirty(next);
			onDirtyChange(draft.pageId, next);
		},
		[draft.pageId, draft.syncedContentHash, onDirtyChange],
	);

	const handleLocalChange = useCallback(
		(_path: string, markdown: string) => {
			latestMarkdownRef.current = markdown;
			recomputeDirty(markdown);
		},
		[recomputeDirty],
	);

	const handleSave = useCallback(
		(_path: string, markdown: string) => {
			latestMarkdownRef.current = markdown;
			void saveDraft(draft.pageId, markdown);
		},
		[draft.pageId],
	);

	const handlePush = useCallback(async () => {
		setPushing(true);
		setMessage(null);
		try {
			// Ensure the newest edit is persisted before diffing on the server.
			await saveDraft(draft.pageId, latestMarkdownRef.current);
			const { draft: updated, result } = await pushPage(draft.pageId);
			setDirty(false);
			onDirtyChange(draft.pageId, false);
			onPushed(updated);
			setMessage({
				text:
					result.mode === "noop"
						? "Already up to date on Notion."
						: "Pushed to Notion.",
				type: "success",
			});
		} catch (error) {
			setMessage({
				text: error instanceof Error ? error.message : "Push failed.",
				type: "error",
			});
		} finally {
			setPushing(false);
		}
	}, [draft.pageId, onDirtyChange, onPushed]);

	return (
		<div className="relative flex h-full min-w-0 flex-1 flex-col">
			<div
				className={`shrink-0 overflow-hidden border-b border-[var(--border)] transition-[max-height] duration-200 ease-in-out md:max-h-none ${
					headerHidden ? "max-h-0 border-b-0" : "max-h-14"
				}`}
			>
				<header className="flex items-center gap-1 px-2 py-2 sm:gap-3 sm:px-4 sm:py-2.5">
					<Button
						variant="ghost"
						size="icon"
						aria-label="Open menu"
						title="Open menu"
						onClick={onOpenMenu}
						className="size-9 shrink-0 md:hidden"
					>
						<MingcuteLayoutLeftLine className="size-4" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Search Notion"
						title="Search Notion"
						onClick={onOpenSearch}
						className="size-9 shrink-0 md:hidden"
					>
						<MingcuteSearchLine className="size-4" />
					</Button>

					<div className="min-w-0 flex-1">
						<h2 className="truncate text-sm font-medium">{draft.title}</h2>
						<p className="truncate text-xs opacity-50">
							{dirty ? "Unsaved changes" : "Synced with Notion"}
						</p>
					</div>

					{draft.url ? (
						<a
							href={draft.url}
							target="_blank"
							rel="noopener noreferrer"
							className="hidden rounded-md px-2 py-1 text-xs opacity-60 hover:bg-[var(--muted)] hover:opacity-100 md:inline-block"
						>
							Open in Notion ↗
						</a>
					) : null}
					<button
						type="button"
						onClick={handlePush}
						disabled={pushing || !dirty}
						className="hidden rounded-md bg-[var(--foreground)] px-3 py-1.5 text-xs font-medium text-[var(--background)] disabled:opacity-40 md:block"
					>
						{pushing ? "Pushing…" : "Push to Notion"}
					</button>

					<Button
						ref={menuButtonRef}
						variant="ghost"
						size="icon"
						aria-label="Page actions"
						title="Page actions"
						onClick={() => setMenuOpen((open) => !open)}
						className="size-9 shrink-0 md:hidden"
					>
						<MingcuteMore2Line className="size-4" />
					</Button>
				</header>
			</div>

			{/* Rendered outside the header's collapsing (overflow-hidden) wrapper
			    above so it isn't clipped when that wrapper animates its height. */}
			{menuOpen ? (
				<div
					ref={menuPanelRef}
					className="absolute right-2 top-14 z-20 w-48 rounded-md border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg md:hidden"
				>
					{draft.url ? (
						<a
							href={draft.url}
							target="_blank"
							rel="noopener noreferrer"
							onClick={() => setMenuOpen(false)}
							className="block px-3 py-2 text-sm hover:bg-[var(--muted)]"
						>
							Open in Notion ↗
						</a>
					) : null}
					<button
						type="button"
						onClick={() => {
							setMenuOpen(false);
							void handlePush();
						}}
						disabled={pushing || !dirty}
						className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--muted)] disabled:opacity-40"
					>
						{pushing ? "Pushing…" : "Push to Notion"}
					</button>
				</div>
			) : null}

			{conflict ? (
				<div className="flex items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-600 dark:text-amber-400">
					<span className="flex-1">
						This page changed in Notion since your last sync, and you have local
						edits. Pushing will attempt a targeted update.
					</span>
					<button
						type="button"
						onClick={onTakeRemote}
						className="rounded-md border border-amber-500/50 px-2 py-1 font-medium hover:bg-amber-500/20"
					>
						Discard local &amp; reload
					</button>
				</div>
			) : null}

			{message ? (
				<div
					className={`px-4 py-1.5 text-xs ${
						message.type === "success" ? "text-emerald-500" : "text-red-500"
					}`}
				>
					{message.text}
				</div>
			) : null}

			<div ref={contentRef} className="min-h-0 flex-1 overflow-hidden">
				<EditorView
					key={draft.pageId}
					path={draft.pageId}
					initialMarkdown={draft.markdown}
					onLocalChange={handleLocalChange}
					onSave={handleSave}
					onOpenExternalLink={(href) => {
						window.open(href, "_blank", "noopener");
					}}
					onOpenWikiLink={() => {
						setMessage({
							text: "Wiki links are not supported in the Notion web editor yet.",
							type: "error",
						});
					}}
					onOpenNotionMentionLink={(href) => {
						window.open(href, "_blank", "noopener");
					}}
					onMessage={(text, type) => setMessage({ text, type })}
				/>
			</div>
		</div>
	);
}
