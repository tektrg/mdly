import { EditorView } from "@hubble.md/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { pushPage, saveDraft } from "../notion/pageSync";
import { comparableContentHash, type Draft } from "../store/drafts";

type Message = { text: string; type: "success" | "error" } | null;

type Props = {
	draft: Draft;
	conflict: boolean;
	onDirtyChange: (pageId: string, dirty: boolean) => void;
	onPushed: (draft: Draft) => void;
	onTakeRemote: () => void;
};

export function EditorPane({
	draft,
	conflict,
	onDirtyChange,
	onPushed,
	onTakeRemote,
}: Props) {
	const latestMarkdownRef = useRef(draft.markdown);
	const [dirty, setDirty] = useState(
		() => comparableContentHash(draft.markdown) !== draft.syncedContentHash,
	);
	const [pushing, setPushing] = useState(false);
	const [message, setMessage] = useState<Message>(null);

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
		<div className="flex h-full min-w-0 flex-1 flex-col">
			<header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2.5 sm:gap-3">
				<div className="min-w-0 flex-1 basis-full sm:basis-auto">
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
						className="rounded-md px-2 py-2 text-xs opacity-60 hover:bg-[var(--muted)] hover:opacity-100 sm:py-1"
					>
						Open in Notion ↗
					</a>
				) : null}
				<button
					type="button"
					onClick={handlePush}
					disabled={pushing || !dirty}
					className="rounded-md bg-[var(--foreground)] px-3 py-2 text-xs font-medium text-[var(--background)] disabled:opacity-40 sm:py-1.5"
				>
					{pushing ? "Pushing…" : "Push to Notion"}
				</button>
			</header>

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

			<div className="min-h-0 flex-1 overflow-hidden">
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
