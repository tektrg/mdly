import { useEffect, useRef, useState } from "react";
import { searchNotion } from "../api/client";
import type { NotionSearchResult } from "../notion/types";

type Props = {
	onSelect: (result: NotionSearchResult) => void;
	onClose: () => void;
};

export function SearchDialog({ onSelect, onClose }: Props) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<NotionSearchResult[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		const trimmed = query.trim();
		if (!trimmed) {
			setResults([]);
			setError(null);
			return;
		}
		let cancelled = false;
		setLoading(true);
		const timer = window.setTimeout(() => {
			searchNotion(trimmed)
				.then((found) => {
					if (!cancelled) {
						setResults(found);
						setError(null);
					}
				})
				.catch((err: unknown) => {
					if (!cancelled) {
						setError(err instanceof Error ? err.message : "Search failed.");
						setResults([]);
					}
				})
				.finally(() => {
					if (!cancelled) setLoading(false);
				});
		}, 250);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [query]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 sm:items-start sm:p-4 sm:pt-[12vh]"
			onClick={onClose}
			onKeyDown={(event) => {
				if (event.key === "Escape") onClose();
			}}
		>
			<div
				className="flex h-full w-full flex-col overflow-hidden bg-[var(--background)] sm:h-auto sm:max-w-xl sm:rounded-xl sm:border sm:border-[var(--border)] sm:shadow-2xl"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="flex items-center border-b border-[var(--border)]">
					<input
						ref={inputRef}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search Notion pages and databases…"
						className="min-w-0 flex-1 bg-transparent px-4 py-3.5 text-sm outline-none"
					/>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close search"
						className="mr-1 shrink-0 rounded-md px-3 py-2 text-xs opacity-60 hover:bg-[var(--muted)] hover:opacity-100 sm:hidden"
					>
						Cancel
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto sm:max-h-[50vh] sm:flex-none">
					{loading ? (
						<p className="px-4 py-3 text-sm opacity-60">Searching…</p>
					) : error ? (
						<p className="px-4 py-3 text-sm text-red-500">{error}</p>
					) : results.length === 0 && query.trim() ? (
						<p className="px-4 py-3 text-sm opacity-60">No results.</p>
					) : (
						<ul>
							{results.map((result) => (
								<li key={result.id}>
									<button
										type="button"
										onClick={() => onSelect(result)}
										className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-[var(--muted)]"
									>
										<span className="text-xs opacity-50">
											{result.object === "page" ? "📄" : "🗂️"}
										</span>
										<span className="flex-1 truncate">{result.title}</span>
										{result.object !== "page" ? (
											<span className="text-[10px] uppercase opacity-40">
												database
											</span>
										) : null}
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</div>
	);
}
