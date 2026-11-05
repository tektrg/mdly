import { Button } from "@hubble.md/ui";
import { useEffect, useState } from "react";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import { desktopApi } from "../../desktopApi";
import type { DocumentTableRow } from "../documentTableView";
import { stripFrontMatter } from "../properties/firstHeading";
import {
	formatPropertyValue,
	type PropertyField,
} from "../properties/propertyFields";

/** Body characters previewed; the full note is one click away. */
const PEEK_PREVIEW_CHARS = 20_000;

type PeekText =
	| { kind: "loading" }
	| { kind: "ready"; text: string }
	| { kind: "failed"; message: string };

/** Read-only side panel: a card's properties and the start of its body. */
export function BoardPeek({
	row,
	title,
	fields,
	onOpen,
	onClose,
}: {
	row: DocumentTableRow;
	title: string;
	fields: readonly PropertyField[];
	onOpen: (row: DocumentTableRow) => void;
	onClose: () => void;
}) {
	const [body, setBody] = useState<PeekText>({ kind: "loading" });
	// Re-read when the card's file changes on disk (a move rewrites it).
	const { openPath, modifiedAt } = row;
	// biome-ignore lint/correctness/useExhaustiveDependencies: modifiedAt is the re-read trigger.
	useEffect(() => {
		let cancelled = false;
		setBody({ kind: "loading" });
		desktopApi
			.readFileText(openPath)
			.then((text) => {
				if (!cancelled) {
					setBody({ kind: "ready", text: stripFrontMatter(text).trim() });
				}
			})
			.catch((error: unknown) => {
				if (!cancelled) setBody({ kind: "failed", message: String(error) });
			});
		return () => {
			cancelled = true;
		};
	}, [openPath, modifiedAt]);
	const properties = fields
		.map((field) => ({
			field,
			text: formatPropertyValue(row.properties?.[field.id], field.id),
		}))
		.filter((entry) => entry.text.length > 0);
	return (
		<aside
			aria-label={`Peek: ${title}`}
			data-board-peek={row.path}
			className="flex h-full w-[22rem] shrink-0 flex-col border-s border-border bg-background"
		>
			<header className="flex shrink-0 items-start gap-2 px-3 py-2">
				<h2 className="m-0 min-w-0 flex-1 text-sm font-semibold break-words">
					{title}
				</h2>
				<Button size="sm" variant="ghost" onClick={() => onOpen(row)}>
					Open
				</Button>
				<Button
					size="sm"
					variant="ghost"
					aria-label="Close peek"
					onClick={onClose}
				>
					<MingcuteCloseLine aria-hidden="true" className="size-3.5" />
				</Button>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
				{properties.length > 0 ? (
					<dl className="m-0 mb-3 grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
						{properties.map(({ field, text }) => (
							<div key={field.id} className="contents">
								<dt className="truncate text-muted-foreground">
									{field.label}
								</dt>
								<dd className="m-0 break-words">{text}</dd>
							</div>
						))}
					</dl>
				) : null}
				{body.kind === "loading" ? (
					<p className="m-0 text-xs text-muted-foreground">Loading…</p>
				) : body.kind === "failed" ? (
					<p className="m-0 text-xs text-destructive">
						This note could not be read: {body.message}
					</p>
				) : body.text.length === 0 ? (
					<p className="m-0 text-xs text-muted-foreground">Empty note.</p>
				) : (
					<pre className="m-0 font-sans text-xs leading-relaxed break-words whitespace-pre-wrap">
						{body.text.slice(0, PEEK_PREVIEW_CHARS)}
					</pre>
				)}
			</div>
		</aside>
	);
}
