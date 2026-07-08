import { Button } from "@hubble.md/ui";
import { useCallback, useEffect, useState } from "react";
import MingcuteLayoutLeftLine from "~icons/mingcute/layout-left-line";
import { logout } from "../api/client";
import { openPage, takeRemote } from "../notion/pageSync";
import type { NotionSearchResult, SessionStatus } from "../notion/types";
import {
	hasLocalChanges,
	indexedDbDraftStore as store,
	type Draft,
} from "../store/drafts";
import { DatabaseViewer } from "./DatabaseViewer";
import { EditorPane } from "./EditorPane";
import { SearchDialog } from "./SearchDialog";

type Selection =
	| { kind: "page"; draft: Draft; conflict: boolean }
	| { kind: "database"; source: NotionSearchResult }
	| null;

const SIDEBAR_COLLAPSED_KEY = "mdly-sidebar-collapsed";

function readSidebarCollapsed() {
	if (typeof localStorage === "undefined") return false;
	return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
}

export function AppShell({ session }: { session: SessionStatus }) {
	const [drafts, setDrafts] = useState<Draft[]>([]);
	const [selection, setSelection] = useState<Selection>(null);
	const [searchOpen, setSearchOpen] = useState(false);
	const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);

	const toggleSidebar = useCallback(() => {
		setSidebarCollapsed((collapsed) => {
			const next = !collapsed;
			if (typeof localStorage !== "undefined") {
				localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
			}
			return next;
		});
	}, []);

	const refreshDrafts = useCallback(async () => {
		const list = await store.list();
		setDrafts(list);
		setDirtyMap(
			Object.fromEntries(list.map((draft) => [draft.pageId, hasLocalChanges(draft)])),
		);
	}, []);

	useEffect(() => {
		void refreshDrafts();
	}, [refreshDrafts]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setSearchOpen(true);
			} else if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
				event.preventDefault();
				toggleSidebar();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [toggleSidebar]);

	const openPageResult = useCallback(
		async (result: NotionSearchResult) => {
			setBusy(true);
			setError(null);
			try {
				const outcome = await openPage(result);
				setSelection({
					kind: "page",
					draft: outcome.draft,
					conflict: outcome.status === "conflict",
				});
				await refreshDrafts();
			} catch (err) {
				setError(err instanceof Error ? err.message : "Could not open page.");
			} finally {
				setBusy(false);
			}
		},
		[refreshDrafts],
	);

	const handleSelectResult = useCallback(
		(result: NotionSearchResult) => {
			setSearchOpen(false);
			if (result.object === "page") {
				void openPageResult(result);
			} else {
				setSelection({ kind: "database", source: result });
			}
		},
		[openPageResult],
	);

	const openStoredDraft = useCallback((draft: Draft) => {
		setSelection({ kind: "page", draft, conflict: false });
	}, []);

	const handleTakeRemote = useCallback(
		async (pageId: string) => {
			setBusy(true);
			try {
				const draft = await takeRemote(pageId);
				setSelection({ kind: "page", draft, conflict: false });
				await refreshDrafts();
			} catch (err) {
				setError(err instanceof Error ? err.message : "Reload failed.");
			} finally {
				setBusy(false);
			}
		},
		[refreshDrafts],
	);

	const handlePushed = useCallback(
		(updated: Draft) => {
			setSelection((current) =>
				current?.kind === "page" && current.draft.pageId === updated.pageId
					? { kind: "page", draft: updated, conflict: false }
					: current,
			);
			void refreshDrafts();
		},
		[refreshDrafts],
	);

	const handleDirtyChange = useCallback((pageId: string, dirty: boolean) => {
		setDirtyMap((current) => ({ ...current, [pageId]: dirty }));
	}, []);

	return (
		<div className="flex h-full">
			{sidebarCollapsed ? null : (
			<aside className="flex w-64 shrink-0 flex-col border-r border-[var(--border)]">
				<div className="flex items-center justify-between px-3 py-3">
					<div className="flex min-w-0 items-center gap-2">
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Collapse sidebar"
							title="Collapse sidebar (⌘\\)"
							onClick={toggleSidebar}
						>
							<MingcuteLayoutLeftLine className="size-3.5" />
						</Button>
						<div className="min-w-0">
							<p className="text-sm font-semibold">mdly</p>
							<p className="truncate text-xs opacity-50">
								{session.workspaceName ?? "Notion"}
							</p>
						</div>
					</div>
					<button
						type="button"
						onClick={() => setSearchOpen(true)}
						className="rounded-md border border-[var(--border)] px-2 py-1 text-xs opacity-70 hover:opacity-100"
						title="Search Notion (⌘K)"
					>
						Search
					</button>
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto px-1.5">
					<p className="px-1.5 py-1 text-[10px] font-medium uppercase tracking-wide opacity-40">
						Recent
					</p>
					{drafts.length === 0 ? (
						<p className="px-1.5 py-2 text-xs opacity-50">
							Search to open a Notion page.
						</p>
					) : (
						<ul>
							{drafts.map((draft) => {
								const active =
									selection?.kind === "page" &&
									selection.draft.pageId === draft.pageId;
								return (
									<li key={draft.pageId}>
										<button
											type="button"
											onClick={() => openStoredDraft(draft)}
											className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm hover:bg-[var(--muted)] ${
												active ? "bg-[var(--muted)]" : ""
											}`}
										>
											<span className="flex-1 truncate">{draft.title}</span>
											{dirtyMap[draft.pageId] ? (
												<span
													className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
													title="Unsaved changes"
												/>
											) : null}
										</button>
									</li>
								);
							})}
						</ul>
					)}
				</div>

				<div className="border-t border-[var(--border)] px-3 py-2">
					<button
						type="button"
						onClick={() => {
							void logout().then(() => window.location.reload());
						}}
						className="text-xs opacity-60 hover:opacity-100"
					>
						Disconnect Notion
					</button>
				</div>
			</aside>
			)}

			<main className="flex min-w-0 flex-1 flex-col">
				{sidebarCollapsed ? (
					<div className="flex items-center px-2 py-1.5">
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Expand sidebar"
							title="Expand sidebar (⌘\\)"
							onClick={toggleSidebar}
						>
							<MingcuteLayoutLeftLine className="size-3.5" />
						</Button>
					</div>
				) : null}
				{error ? (
					<div className="border-b border-red-500/40 bg-red-500/10 px-4 py-1.5 text-xs text-red-500">
						{error}
					</div>
				) : null}
				{busy && !selection ? (
					<div className="flex flex-1 items-center justify-center text-sm opacity-60">
						Opening…
					</div>
				) : selection?.kind === "page" ? (
					<EditorPane
						draft={selection.draft}
						conflict={selection.conflict}
						onDirtyChange={handleDirtyChange}
						onPushed={handlePushed}
						onTakeRemote={() => handleTakeRemote(selection.draft.pageId)}
					/>
				) : selection?.kind === "database" ? (
					<DatabaseViewer
						source={selection.source}
						onOpenRow={(row) =>
							void openPageResult({
								id: row.pageId,
								object: "page",
								title: row.title,
								url: row.url,
								lastEditedTime: null,
							})
						}
					/>
				) : (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 text-center opacity-60">
						<p className="text-sm">Search for a Notion page to start editing.</p>
						<button
							type="button"
							onClick={() => setSearchOpen(true)}
							className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--muted)]"
						>
							Search Notion (⌘K)
						</button>
					</div>
				)}
			</main>

			{searchOpen ? (
				<SearchDialog
					onSelect={handleSelectResult}
					onClose={() => setSearchOpen(false)}
				/>
			) : null}
		</div>
	);
}
