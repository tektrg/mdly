import { Button } from "@hubble.md/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { desktopApi } from "../desktopApi";
import type { NotionDatabaseQueryResult } from "../desktopApi/types";
import { openOrImportNotionPage } from "../fileActions";
import { dirname } from "../lib/filePath";
import type { NotionDatabaseMetadata } from "../notion/notionDatabase";

type NotionDatabaseViewerProps = {
	path: string;
	metadata: NotionDatabaseMetadata;
	refreshToken?: number;
	onScrollContainerChange?: (el: HTMLDivElement | null) => void;
};

type QueryStatus = "loading" | "ready" | "error";

export function NotionDatabaseViewer({
	path,
	metadata,
	refreshToken = 0,
	onScrollContainerChange,
}: NotionDatabaseViewerProps) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
	const [query, setQuery] = useState<NotionDatabaseQueryResult | null>(null);
	const [status, setStatus] = useState<QueryStatus>("loading");
	const [error, setError] = useState<string | null>(null);
	const currentCursor = cursorStack[cursorStack.length - 1] ?? null;
	const columns = useMemo(() => query?.columns ?? [], [query]);
	const detailFolderPath = dirname(path) ?? path;

	useEffect(() => {
		onScrollContainerChange?.(scrollRef.current);
		return () => onScrollContainerChange?.(null);
	}, [onScrollContainerChange]);

	useEffect(() => {
		// Participates in dependencies as an explicit user refresh signal.
		void refreshToken;
		let disposed = false;
		const loadRows = async () => {
			setStatus("loading");
			setError(null);
			try {
				const nextQuery = await desktopApi.queryNotionDatabase({
					sourceId: metadata.sourceId,
					sourceObject: metadata.object,
					account: metadata.account,
					startCursor: currentCursor,
					pageSize: metadata.pageSize,
				});
				if (disposed) return;
				setQuery(nextQuery);
				setStatus("ready");
			} catch (error) {
				if (disposed) return;
				setError(error instanceof Error ? error.message : String(error));
				setStatus("error");
			}
		};
		void loadRows();
		return () => {
			disposed = true;
		};
	}, [
		currentCursor,
		metadata.account,
		metadata.object,
		metadata.pageSize,
		metadata.sourceId,
		refreshToken,
	]);

	async function openRow(row: NotionDatabaseQueryResult["rows"][number]) {
		try {
			await openOrImportNotionPage(
				{
					id: row.pageId,
					object: "page",
					account: metadata.account,
					title: row.title || "Untitled Notion page",
					url: row.url,
					lastEditedTime: row.lastEditedTime,
				},
				{ folderPath: detailFolderPath },
			);
		} catch (error) {
			toast.error("Failed to open Notion row", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
				<h1 className="m-0 min-w-0 truncate text-sm font-medium">
					{metadata.title}
				</h1>
				<div className="flex items-center gap-2">
					<Button
						disabled={cursorStack.length <= 1 || status === "loading"}
						size="sm"
						variant="outline"
						onClick={() =>
							setCursorStack((stack) =>
								stack.length <= 1 ? stack : stack.slice(0, -1),
							)
						}
					>
						Previous
					</Button>
					<Button
						disabled={
							!query?.hasMore || !query.nextCursor || status === "loading"
						}
						size="sm"
						variant="outline"
						onClick={() => {
							if (!query?.nextCursor) return;
							setCursorStack((stack) => [...stack, query.nextCursor]);
						}}
					>
						Next
					</Button>
				</div>
			</header>
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
				{status === "loading" ? (
					<p className="m-0 p-3 text-sm text-muted-foreground">Loading...</p>
				) : null}
				{status === "error" ? (
					<p className="m-0 p-3 text-sm text-destructive">
						{error ?? "Failed to load Notion database."}
					</p>
				) : null}
				{status === "ready" && query?.rows.length === 0 ? (
					<p className="m-0 p-3 text-sm text-muted-foreground">No rows</p>
				) : null}
				{status === "ready" && query && query.rows.length > 0 ? (
					<table className="w-full min-w-max border-separate border-spacing-0 text-sm">
						<thead>
							<tr>
								<th className="sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-start font-medium">
									Row
								</th>
								{columns.map((column) => (
									<th
										key={column}
										className="sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-start font-medium"
									>
										{column}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{query.rows.map((row) => (
								<tr key={row.pageId} className="hover:bg-muted/40">
									<td className="max-w-80 border-b border-border px-3 py-2 align-top">
										<button
											className="max-w-full truncate text-start text-primary outline-hidden hover:underline focus-visible:underline"
											type="button"
											onClick={() => void openRow(row)}
										>
											{row.title || "Untitled"}
										</button>
									</td>
									{columns.map((column) => (
										<td
											key={`${row.pageId}:${column}`}
											className="max-w-80 border-b border-border px-3 py-2 align-top text-muted-foreground"
										>
											<span className="line-clamp-3 whitespace-pre-wrap">
												{row.properties[column] ?? ""}
											</span>
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				) : null}
			</div>
		</div>
	);
}
