import { useEffect, useState } from "react";
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
};

export function DatabaseViewer({ source, onOpenRow }: Props) {
	const [state, setState] = useState<
		| { status: "loading" }
		| { status: "error"; message: string }
		| { status: "ready"; data: NotionDatabaseQueryResult }
	>({ status: "loading" });

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
			<header className="border-b border-[var(--border)] px-4 py-2.5">
				<h2 className="truncate text-sm font-medium">{source.title}</h2>
				<p className="text-xs opacity-50">Read-only database view</p>
			</header>
			<div className="min-h-0 flex-1 overflow-auto p-4">
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
