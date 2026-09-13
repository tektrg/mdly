// Real runtime import of the pure `resolveAnchor` function (D2: anchor
// *resolution* is kit-side, using the live editor draft, not whatever the
// host last persisted). Only the runtime value is imported -- every type
// used in this file's public signature is the locally-declared, structurally
// identical one from "./types.js" (D4: the kit's published .d.ts must never
// reference `@mdly/doc-comments`), and structural typing makes them
// interchangeable at the `resolveAnchor` call site below.
//
// `@mdly/doc-comments` is a devDependency of this package (same convention
// as `@mdly/doc-history` elsewhere in this kit) -- Vite bundles this pure
// function into `dist/index.js` at build time, so it never becomes a runtime
// resolution requirement for downstream consumers of the kit.
import { resolveAnchor } from "@mdly/doc-comments";
import type { Editor, JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { useCallback, useEffect, useState } from "react";
import { tiptapDocToMarkdown } from "../engine/prosemirrorToMarkdown.js";
import type {
	AnchorResolution,
	CommentOptions,
	CommentThread,
	CommentThreadEvent,
} from "./types.js";

export type ResolvedThread = CommentThread & {
	anchorResolution: AnchorResolution;
};

/**
 * Relocates a recorded quote anchor onto live ProseMirror positions by
 * searching the live doc's own plain text (`textBetween`, the same space
 * `buildQuoteAnchor` captured `quote`/context from) -- never by reusing the
 * flattened-markdown offsets `resolveAnchor` returns. Those offsets count
 * markdown syntax (`# `, `- `, `**`, double-newline block joins) that has no
 * ProseMirror position, so consuming them as `range.from` pushed every
 * highlight below its real location by however much markup sat above it.
 * Occurrence disambiguation mirrors `resolveAnchor`'s quote+context rule:
 * a repeated quote with no unique context match resolves to null.
 *
 * Takes a prebuilt `TextIndex` so one resolve pass shares a single document
 * walk across all threads instead of scanning per thread.
 */
type TextIndex = {
	fullText: string;
	posAt: number[];
	endPm: number | null;
	failed: boolean;
};

/**
 * One descendants walk per resolve pass, shared by every thread: each
 * thread's quote search then runs against the same `fullText`/`posAt`
 * instead of re-scanning the whole document per thread.
 */
function buildTextIndex(doc: ProseMirrorNode): TextIndex {
	const fullText = doc.textBetween(0, doc.content.size, "\n");
	const posAt: number[] = [];
	let cursor = 0;
	let endPm: number | null = null;
	let failed = false;
	doc.descendants((node, pos) => {
		if (failed) return false;
		if (!node.isText || !node.text) return true;
		const start = fullText.indexOf(node.text, cursor);
		if (start === -1) {
			failed = true;
			return false;
		}
		for (let i = cursor; i < start; i++) posAt[i] = pos;
		for (let j = 0; j < node.text.length; j++) posAt[start + j] = pos + j;
		cursor = start + node.text.length;
		endPm = pos + node.text.length;
		return true;
	});
	return { fullText, posAt, endPm, failed };
}

function pmRangeForQuoteWithIndex(
	index: TextIndex,
	anchor: CommentThread["opener"]["anchor"],
): { from: number; to: number } | null {
	if (anchor.quote.length === 0) return null;
	const { fullText } = index;

	const occurrences: number[] = [];
	let idx = fullText.indexOf(anchor.quote);
	while (idx !== -1) {
		occurrences.push(idx);
		idx = fullText.indexOf(anchor.quote, idx + 1);
	}
	if (occurrences.length === 0) return null;
	let candidates = occurrences;
	if (occurrences.length > 1) {
		const contextBefore = anchor.contextBefore ?? "";
		const contextAfter = anchor.contextAfter ?? "";
		if (contextBefore.length === 0 && contextAfter.length === 0) return null;
		candidates = occurrences.filter((from) => {
			const to = from + anchor.quote.length;
			const beforeOk =
				fullText.slice(Math.max(0, from - contextBefore.length), from) ===
				contextBefore;
			const afterOk =
				fullText.slice(to, to + contextAfter.length) === contextAfter;
			return beforeOk && afterOk;
		});
		if (candidates.length !== 1) return null;
	}
	const fromText = candidates[0] as number;
	return textIndexRangeToPmRange(
		index,
		fromText,
		fromText + anchor.quote.length,
	);
}

/**
 * Translates a half-open `[fromText, toText)` range over `fullText` (the
 * doc's own `textBetween`) to ProseMirror positions. Text nodes are consumed
 * greedily in document order against `fullText`, so block separators between
 * them need no special-casing -- whatever isn't node text is, by
 * construction, a separator. Separator indices map to the next segment's
 * start, which keeps ranges ending exactly on a block boundary valid.
 */
function textIndexRangeToPmRange(
	index: TextIndex,
	fromText: number,
	toText: number,
): { from: number; to: number } | null {
	const { fullText, posAt, endPm, failed } = index;
	if (fromText < 0 || toText > fullText.length || fromText >= toText) {
		return null;
	}
	if (failed || endPm === null) return null;
	const from = posAt[fromText];
	if (from === undefined) return null;
	const to = toText === fullText.length ? endPm : posAt[toText];
	if (to === undefined || to <= from) return null;
	return { from, to };
}

function sameAnchorResolution(
	a: AnchorResolution,
	b: AnchorResolution,
): boolean {
	return (
		a.status === b.status &&
		a.method === b.method &&
		a.range?.from === b.range?.from &&
		a.range?.to === b.range?.to
	);
}

// Events are immutable once appended (a reply/resolve/reopen never mutates an
// earlier event in place), so same length + same ids in order means same
// content -- no need to diff `text`/`by`/`kind` per event too.
function sameEvents(a: CommentThreadEvent[], b: CommentThreadEvent[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	return a.every((event, index) => event.id === b[index]?.id);
}

/**
 * Exported (not just used internally) because `CommentExtension.ts`'s
 * `setCommentThreads` also needs it, as an ignition guard comparing an
 * incoming thread list against whatever the plugin already holds -- see that
 * function's doc comment and
 * memory/Areas/editor-architecture/202607160130-mdly-oom-react-update-queue-explosion.md
 * for why a reference-based guard here isn't enough on its own.
 */
export function sameResolvedThreads(
	a: ResolvedThread[],
	b: ResolvedThread[],
): boolean {
	if (a.length !== b.length) return false;
	return a.every((thread, index) => {
		const next = b[index];
		return (
			next !== undefined &&
			thread.id === next.id &&
			thread.state === next.state &&
			sameEvents(thread.events, next.events) &&
			sameAnchorResolution(thread.anchorResolution, next.anchorResolution)
		);
	});
}

export interface UseCommentThreadsResult {
	resolvedThreads: ResolvedThread[];
	refetch: () => void;
	error: string | null;
}

const NOOP_RESULT: UseCommentThreadsResult = {
	resolvedThreads: [],
	refetch: () => {},
	error: null,
};

/**
 * Opt-in gate (R15): hooks below run every render (Rules of Hooks forbid
 * conditional hook calls) but no-op internally whenever `options` is
 * undefined -- no fetch, no editor subscription -- and the return value
 * collapses to the static `NOOP_RESULT` so nothing renders either.
 */
export function useCommentThreads(
	options: CommentOptions | undefined,
	editor: Editor | null,
	flattenDocument: (docBody: string) => string,
): UseCommentThreadsResult {
	const [rawThreads, setRawThreads] = useState<CommentThread[]>([]);
	const [resolvedThreads, setResolvedThreads] = useState<ResolvedThread[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [fetchTick, setFetchTick] = useState(0);

	const docId = options?.docId;
	const refreshSignal = options?.refreshSignal;
	const getThreads = options?.getThreads;
	const readRevisionContent = options?.readRevisionContent;

	// Fetch (or re-fetch) the raw thread list on mount and whenever docId,
	// refreshSignal (R22 cross-window refresh), or a manual refetch() fires.
	useEffect(() => {
		if (!getThreads || !docId) {
			setRawThreads([]);
			setError(null);
			return;
		}
		let cancelled = false;
		getThreads(docId)
			.then((threads) => {
				if (cancelled) return;
				// Host-supplied `getThreads` (backed by `@mdly/doc-comments`'s store,
				// whose own `CommentThread.events` doc comment says "thread-opened
				// first, then replies/resolves/reopens") crosses into this kit's
				// local `CommentThread` type here, whose `events` field is documented
				// the opposite way -- "every reply/resolve/reopen event AFTER the
				// opener" (see types.ts). Normalize at this boundary so the panel
				// and any other consumer never renders the opener twice.
				setRawThreads(
					threads.map((thread) => ({
						...thread,
						events: thread.events.filter(
							(event) => event.id !== thread.opener.id,
						),
					})),
				);
				setError(null);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setRawThreads([]);
				setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: fetchTick is a manual refetch trigger, not a data dependency.
	}, [getThreads, docId, refreshSignal, fetchTick]);

	// Re-resolve every raw thread's anchor against the LIVE editor draft
	// whenever the raw list changes or the editor's document changes -- never
	// against a stale prop, and never gated behind a threads re-fetch.
	useEffect(() => {
		if (!readRevisionContent) {
			setResolvedThreads((previous) => (previous.length === 0 ? previous : []));
			return;
		}

		// Empty fast path: with no threads there is nothing to anchor, so
		// skip the full-document serialization (`getJSON` + Markdown) and the
		// editor subscription entirely. A later threads arrival re-runs this
		// effect via `rawThreads` and subscribes then.
		if (rawThreads.length === 0) {
			setResolvedThreads((previous) => (previous.length === 0 ? previous : []));
			return;
		}

		let cancelled = false;
		// Generation guard: rapid successive edits start overlapping async
		// resolve passes; only the latest may publish, so a slow earlier pass
		// can never overwrite a newer result (stale-result protection).
		let generation = 0;
		const resolveAll = () => {
			generation += 1;
			const runId = generation;
			// Serialized once per pass and shared by every thread below --
			// never re-serialized per thread.
			const docBody = editor
				? tiptapDocToMarkdown(editor.getJSON() as JSONContent)
				: "";
			const currentFlattenedText = flattenDocument(docBody);
			// One document walk per pass, shared by every thread's PM-range
			// lookup instead of a full scan per thread.
			const textIndex = editor ? buildTextIndex(editor.state.doc) : null;
			// Threads pinned to the same revision share one backing read and
			// one flatten of that revision within this pass.
			const revisionContentCache = new Map<string, Promise<string | null>>();
			const readRevisionContentCached = (revisionId: string) => {
				const cached = revisionContentCache.get(revisionId);
				if (cached) return cached;
				const pending = readRevisionContent(revisionId);
				revisionContentCache.set(revisionId, pending);
				return pending;
			};
			const flattenedRevisionCache = new Map<string, string>();
			const flattenDocumentCached = (revisionBody: string) => {
				const cached = flattenedRevisionCache.get(revisionBody);
				if (cached !== undefined) return cached;
				const flattened = flattenDocument(revisionBody);
				flattenedRevisionCache.set(revisionBody, flattened);
				return flattened;
			};
			Promise.all(
				rawThreads.map(async (thread) => {
					const anchorResolution = await resolveAnchor(
						thread.opener.anchor,
						currentFlattenedText,
						readRevisionContentCached,
						flattenDocumentCached,
					);
					if (editor) {
						// `pmRangeForQuote` searches the live doc's own plain text -- the
						// same `textBetween` space `buildQuoteAnchor` captured
						// `quote`/context from. `resolveAnchor` above replays in
						// flattened-markdown space instead, where recorded PM
						// positions don't line up (block overhead, markup like `# `
						// / `**`, `\n` vs `\n\n` joins), so a brand-new comment can
						// come back `orphaned` while its quote is still uniquely
						// present (e.g. a selection ending at the last character:
						// PM `to` is always one past the markdown length). Whenever
						// the live doc still holds a unique quote match, that PM
						// match is ground truth for display -- rescue the orphan
						// rather than flashing "orphaned" on a just-created thread.
						// A genuinely deleted/edited-away quote still finds no
						// match here and stays orphaned, preserving R12.
						const pmRange =
							textIndex !== null
								? pmRangeForQuoteWithIndex(textIndex, thread.opener.anchor)
								: null;
						if (pmRange) {
							if (anchorResolution.status === "orphaned") {
								return {
									...thread,
									anchorResolution: {
										status: "fallback-anchored",
										range: pmRange,
										method: "quote-context",
									} satisfies AnchorResolution,
								};
							}
							return {
								...thread,
								anchorResolution: { ...anchorResolution, range: pmRange },
							};
						}
						const orphaned: AnchorResolution = { status: "orphaned" };
						return { ...thread, anchorResolution: orphaned };
					}
					return { ...thread, anchorResolution };
				}),
			).then((resolved) => {
				if (!cancelled && runId === generation) {
					setResolvedThreads((previous) =>
						sameResolvedThreads(previous, resolved) ? previous : resolved,
					);
				}
			});
		};

		resolveAll();
		if (!editor) {
			return () => {
				cancelled = true;
			};
		}
		// "transaction" (not "update") -- external content reloads apply via
		// `setContent(doc, { emitUpdate: false })`, which suppresses "update"
		// but still dispatches a transaction, so anchors must re-resolve there
		// too or highlights go stale against the old document.
		//
		// Gated on `docChanged` (loop-breaker, same shape as FindReplaceBar's
		// `findMatchesAffectedByTransaction` fix -- see
		// memory/Areas/editor-architecture/202607160130-mdly-oom-react-update-queue-explosion.md):
		// `resolveAnchor` only ever depends on document content
		// (`tiptapDocToMarkdown(editor.getJSON())`), never on selection or
		// plugin meta, so a meta-only/selection-only transaction can never
		// change its result -- including `setCommentThreads`'s own dispatch of
		// `commentThreadsKey` meta, which otherwise re-enters this listener on
		// every render of its own output.
		const onTransaction = ({ transaction }: { transaction: Transaction }) => {
			if (!transaction.docChanged) return;
			resolveAll();
		};
		editor.on("transaction", onTransaction);
		return () => {
			cancelled = true;
			editor.off("transaction", onTransaction);
		};
	}, [readRevisionContent, rawThreads, editor, flattenDocument]);

	const refetch = useCallback(() => {
		setFetchTick((tick) => tick + 1);
	}, []);

	if (!options) return NOOP_RESULT;

	return { resolvedThreads, refetch, error };
}
