import type { Editor, JSONContent } from "@tiptap/core";
import { useCallback, useEffect, useState } from "react";
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
import { tiptapDocToMarkdown } from "../engine/prosemirrorToMarkdown.js";
import type { AnchorResolution, CommentOptions, CommentThread } from "./types.js";

export type ResolvedThread = CommentThread & { anchorResolution: AnchorResolution };

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
				setRawThreads(threads);
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
			setResolvedThreads([]);
			return;
		}

		let cancelled = false;
		const resolveAll = () => {
			const docBody = editor
				? tiptapDocToMarkdown(editor.getJSON() as JSONContent)
				: "";
			const currentFlattenedText = flattenDocument(docBody);
			Promise.all(
				rawThreads.map(async (thread) => {
					const anchorResolution = await resolveAnchor(
						thread.opener.anchor,
						currentFlattenedText,
						readRevisionContent,
						flattenDocument,
					);
					return { ...thread, anchorResolution };
				}),
			).then((resolved) => {
				if (!cancelled) setResolvedThreads(resolved);
			});
		};

		resolveAll();
		if (!editor) {
			return () => {
				cancelled = true;
			};
		}
		editor.on("update", resolveAll);
		return () => {
			cancelled = true;
			editor.off("update", resolveAll);
		};
	}, [readRevisionContent, rawThreads, editor, flattenDocument]);

	const refetch = useCallback(() => {
		setFetchTick((tick) => tick + 1);
	}, []);

	if (!options) return NOOP_RESULT;

	return { resolvedThreads, refetch, error };
}
