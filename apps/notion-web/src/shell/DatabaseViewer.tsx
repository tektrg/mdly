import { Button } from "@hubble.md/ui";
import { useEffect, useRef, useState } from "react";
import MingcuteLayoutLeftLine from "~icons/mingcute/layout-left-line";
import MingcuteSearchLine from "~icons/mingcute/search-line";
import { queryDatabase } from "../api/client";
import type {
	NotionDatabaseQueryResult,
	NotionSearchResult,
} from "../notion/types";

type Props = {
	source: NotionSearchResult;
	onOpenRow: (row: {
		pageId: string;
		title: string;
		url: string | null;
	}) => void;
	onOpenMenu: () => void;
	onOpenSearch: () => void;
};

export function DatabaseViewer({
	source,
	onOpenRow,
	onOpenMenu,
	onOpenSearch,
}: Props) {
	const [state, setState] = useState<
		| { status: "loading" }
		| { status: "error"; message: string }
		| { status: "ready"; data: NotionDatabaseQueryResult }
	>({ status: "loading" });
	const [headerHidden, setHeaderHidden] = useState(false);
	const lastScrollTopRef = useRef(0);

	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		queryDatabase(
			source.id,
			source.object === "data_source" ? "data_source" : "database",
		)
			.then((data) => {
				if (!cancelled) setState({ status: "ready", data });
			})
			.catch((error: unknown) => {
				if (!cancelled) {
					setState({
						status: "error",
						message:
							error instanceof Error
								? error.message
								: "Could not load this database.",
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [source.id, source.object]);

	return (
		<div className="flex h-full min-w-0 flex-1 flex-col">
			<div
				className={`shrink-0 overflow-hidden border-b border-[var(--border)] transition-[max-height] duration-200 ease-in-out md:max-h-none ${
					headerHidden ? "max-h-0 border-b-0" : "max-h-14"
				}`}
			>
				<header className="flex items-center gap-1 px-2 py-2 sm:px-4 sm:py-2.5">
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
						<h2 className="truncate text-sm font-medium">{source.title}</h2>
						<p className="truncate text-xs opacity-50">
							Read-only database view
						</p>
					</div>
				</header>
			</div>
			<div
				className="min-h-0 flex-1 overflow-auto p-4"
				onScroll={(event) => {
					const scrollTop = event.currentTarget.scrollTop;
					const delta = scrollTop - lastScrollTopRef.current;
					lastScrollTopRef.current = scrollTop;
					if (scrollTop <= 0 || delta < -4) {
						setHeaderHidden(false);
					} else if (delta > 4) {
						setHeaderHidden(true);
					}
				}}
			>
				{state.status === "loading" ? (
					<p className="text-sm opacity-60">Loading rows…</p>
				) : state.status === "error" ? (
					<p className="text-sm text-red-500">{state.message}</p>
				) : state.data.rows.length === 0 ? (
					<p className="text-sm opacity-60">No rows.</p>
				) : (
					<>
						<ul className="flex flex-col gap-2 md:hidden">
							{state.data.rows.map((row) => (
								<li key={row.pageId}>
									<button
										type="button"
										onClick={() =>
											onOpenRow({
												pageId: row.pageId,
												title: row.title,
												url: row.url,
											})
										}
										className="flex w-full flex-col gap-1 rounded-md border border-[var(--border)] px-3 py-2.5 text-left hover:bg-[var(--muted)]"
									>
										<span className="text-sm font-medium">{row.title}</span>
										{state.data.columns.slice(0, 3).map((column) => {
											const value = row.properties[column];
											if (!value) return null;
											return (
												<span key={column} className="text-xs opacity-70">
													<span className="opacity-50">{column}: </span>
													{value}
												</span>
											);
										})}
									</button>
								</li>
							))}
						</ul>
						<table className="hidden w-full border-collapse text-sm md:table">
							<thead>
								<tr className="border-b border-[var(--border)] text-left">
									<th className="px-2 py-1.5 font-medium">Title</th>
									{state.data.columns.map((column) => (
										<th key={column} className="px-2 py-1.5 font-medium">
											{column}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{state.data.rows.map((row) => (
									<tr
										key={row.pageId}
										className="border-b border-[var(--border)]/50 hover:bg-[var(--muted)]"
									>
										<td className="px-2 py-1.5">
											<button
												type="button"
												onClick={() =>
													onOpenRow({
														pageId: row.pageId,
														title: row.title,
														url: row.url,
													})
												}
												className="text-left underline-offset-2 hover:underline"
											>
												{row.title}
											</button>
										</td>
										{state.data.columns.map((column) => (
											<td key={column} className="px-2 py-1.5 opacity-80">
												{row.properties[column] ?? ""}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</>
				)}
			</div>
		</div>
	);
}
