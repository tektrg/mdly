import { Button } from "@hubble.md/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../desktopApi";
import type {
	NotionConnectionStatus,
	NotionSearchResult,
} from "../desktopApi/types";
import { Input } from "./ui/input";

const SEARCH_DEBOUNCE_MS = 300;

export function NotionOpenDialog({
	open,
	onOpenChange,
	onImportDatabase,
	onImportPage,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onImportDatabase: (result: NotionSearchResult) => Promise<void>;
	onImportPage: (result: NotionSearchResult) => Promise<void>;
}) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<NotionSearchResult[]>([]);
	const [status, setStatus] = useState<"idle" | "searching" | "importing">(
		"idle",
	);
	const [connection, setConnection] = useState<NotionConnectionStatus | null>(
		null,
	);
	const [connectionStatus, setConnectionStatus] = useState<"idle" | "checking">(
		"idle",
	);
	const [error, setError] = useState<string | null>(null);
	const notionReady = connection?.connected === true;
	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refreshConnection = useCallback(async (account?: string | null) => {
		setConnectionStatus("checking");
		try {
			setConnection(await desktopApi.getNotionConnectionStatus(account));
		} catch (error) {
			setConnection({
				account: account ?? "7lab",
				availableAccounts: [],
				tokenKind: "missing",
				connected: false,
				botName: null,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setConnectionStatus("idle");
		}
	}, []);

	useEffect(() => {
		if (!open) {
			if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
			setQuery("");
			setResults([]);
			setStatus("idle");
			setConnection(null);
			setConnectionStatus("idle");
			setError(null);
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		void refreshConnection();
	}, [open, refreshConnection]);

	useEffect(() => {
		if (!notionReady) return;
		if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
		if (!query.trim()) {
			setResults([]);
			setStatus("idle");
			return;
		}
		debounceTimerRef.current = setTimeout(async () => {
			setStatus("searching");
			setError(null);
			try {
				setResults(await desktopApi.searchNotion(query, connection?.account));
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				setResults([]);
			} finally {
				setStatus("idle");
			}
		}, SEARCH_DEBOUNCE_MS);
		return () => {
			if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
		};
	}, [query, notionReady, connection?.account]);

	if (!open) return null;

	async function selectAccount(account: string) {
		setConnectionStatus("checking");
		setError(null);
		setResults([]);
		try {
			setConnection(await desktopApi.setNotionAccount(account));
		} catch (error) {
			setConnection((current) => ({
				account,
				availableAccounts: current?.availableAccounts ?? [],
				tokenKind: "missing",
				connected: false,
				botName: null,
				error: error instanceof Error ? error.message : String(error),
			}));
		} finally {
			setConnectionStatus("idle");
		}
	}

	async function importResult(result: NotionSearchResult) {
		setStatus("importing");
		setError(null);
		try {
			if (result.object === "page") {
				await onImportPage(result);
			} else {
				await onImportDatabase(result);
			}
			onOpenChange(false);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setStatus("idle");
		}
	}

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[12vh]">
			<div className="w-full max-w-xl rounded-sm border border-border bg-popover p-3 text-popover-foreground shadow-xl">
				<div className="mb-3 flex items-center justify-between gap-3">
					<h2 className="m-0 text-sm font-medium">Open Notion</h2>
					<Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
						Close
					</Button>
				</div>
				<NotionConnectionPanel
					connection={connection}
					status={connectionStatus}
					onRefresh={() => void refreshConnection(connection?.account)}
					onSelectAccount={(account) => void selectAccount(account)}
				/>
				<Input
					autoFocus
					disabled={!notionReady}
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					placeholder="Search Notion"
				/>
				{error ? (
					<p className="m-0 mt-3 text-sm text-destructive">{error}</p>
				) : null}
				<div className="mt-3 max-h-80 overflow-auto">
					{status === "searching" ? (
						<p className="m-0 text-sm text-muted-foreground">Searching...</p>
					) : null}
					{results.map((result) => (
						<button
							key={`${result.object}:${result.id}`}
							className="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-2 text-start text-sm outline-hidden hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
							disabled={status !== "idle" || !notionReady}
							type="button"
							onClick={() => void importResult(result)}
						>
							<span className="min-w-0">
								<span className="block truncate">{result.title}</span>
								<span className="block text-xs text-muted-foreground">
									{result.object === "page" ? "Page" : "Read-only table"}
								</span>
							</span>
							<span className="shrink-0 text-xs text-muted-foreground">
								{result.object}
							</span>
						</button>
					))}
					{results.length === 0 && query && status === "idle" && !error ? (
						<p className="m-0 text-sm text-muted-foreground">No results</p>
					) : null}
				</div>
			</div>
		</div>
	);
}

function NotionConnectionPanel({
	connection,
	status,
	onRefresh,
	onSelectAccount,
}: {
	connection: NotionConnectionStatus | null;
	status: "idle" | "checking";
	onRefresh: () => void;
	onSelectAccount: (account: string) => void;
}) {
	const connected = connection?.connected === true;
	const tokenLabel =
		connection?.tokenKind === "oauth"
			? "OAuth"
			: connection?.tokenKind === "api_key"
				? "API key"
				: "No token";
	return (
		<div className="mb-3 rounded-sm border border-border bg-muted/30 px-2 py-2 text-xs">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="min-w-0">
					<p className="m-0 font-medium">
						{connected ? "Notion connected" : "Notion not connected"}
					</p>
					<p className="m-0 mt-0.5 text-muted-foreground">
						{connection
							? `${connection.account} · ${tokenLabel}${connection.botName ? ` · ${connection.botName}` : ""}`
							: "Checking Notion account"}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{connection && connection.availableAccounts.length > 0 ? (
						<select
							aria-label="Notion account"
							className="h-8 rounded-sm border border-input bg-background px-2 text-xs outline-hidden disabled:opacity-50"
							disabled={status === "checking"}
							value={connection.account}
							onChange={(event) => onSelectAccount(event.currentTarget.value)}
						>
							{connection.availableAccounts.map((account) => (
								<option key={account} value={account}>
									{account}
								</option>
							))}
						</select>
					) : null}
					<Button
						disabled={status === "checking"}
						size="sm"
						variant="outline"
						onClick={onRefresh}
					>
						Check
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() =>
							void desktopApi.openExternalUrl(
								"https://www.notion.so/profile/integrations",
							)
						}
					>
						Link Notion
					</Button>
				</div>
			</div>
			{connection?.error ? (
				<p className="m-0 mt-2 text-destructive">{connection.error}</p>
			) : null}
		</div>
	);
}
