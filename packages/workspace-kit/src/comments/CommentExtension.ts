import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { ResolvedThread } from "./useCommentThreads.js";
import { sameResolvedThreads } from "./useCommentThreads.js";

export interface CommentThreadsPluginState {
	threads: ResolvedThread[];
	/** Thread focused in the panel (paragraph/gutter marker click, or a click on the thread's own item), if any -- its mark gets a stronger highlight. */
	focusedThreadId: string | null;
}

const EMPTY_COMMENT_THREADS_STATE: CommentThreadsPluginState = {
	threads: [],
	focusedThreadId: null,
};

export const commentThreadsKey = new PluginKey<CommentThreadsPluginState>(
	"commentThreads",
);

function sameCommentThreadsState(
	a: CommentThreadsPluginState,
	b: CommentThreadsPluginState,
): boolean {
	return (
		a.focusedThreadId === b.focusedThreadId &&
		sameResolvedThreads(a.threads, b.threads)
	);
}

/**
 * Imperative push of the current resolved thread list -- and which thread,
 * if any, is focused in the panel -- into the plugin's state. The wiring
 * layer (not this slice) calls this whenever `useCommentThreads` produces a
 * new list, AND whenever `focusedThreadId` changes on its own (same threads
 * array, e.g. a paragraph-marker click while the panel is already open).
 * Exactly the `FindReplaceExtension` pattern (`findReplaceHighlightKey` +
 * `tr.setMeta`).
 *
 * Ignition-guarded (same fix shape as `FindReplaceBar`'s
 * `shouldDispatchFindReplaceHighlight`, see
 * memory/Areas/editor-architecture/202607160130-mdly-oom-react-update-queue-explosion.md):
 * `resolvedThreads` from `useCommentThreads` is *usually* reference-stable
 * across no-op recomputes, but nothing upstream guarantees it always will be
 * (e.g. a refetch that returns content-identical-but-freshly-allocated
 * thread objects). Comparing the combined `{threads, focusedThreadId}`
 * against the plugin's own current state before dispatching means an
 * unstable caller degrades to a wasted comparison, not a transaction -- so
 * it can never re-ignite the `editor.on("transaction", resolveAll)` listener
 * in `useCommentThreads`, which is what turns a single redundant dispatch
 * into an unbounded loop (that listener's own dispatch would otherwise look,
 * to this function, just like any other caller).
 */
export function setCommentThreads(
	editor: Editor,
	threads: ResolvedThread[],
	focusedThreadId: string | null = null,
): void {
	const current =
		commentThreadsKey.getState(editor.state) ?? EMPTY_COMMENT_THREADS_STATE;
	const next: CommentThreadsPluginState = { threads, focusedThreadId };
	if (sameCommentThreadsState(current, next)) return;
	editor.view.dispatch(editor.state.tr.setMeta(commentThreadsKey, next));
}

/**
 * One inline `Decoration` per non-orphaned thread over its resolved range --
 * pure decoration, never touches document content (R16), so it can never
 * leak into `getJSON()`/serialized markdown. Overlapping ranges are NOT
 * deduped or merged (R17): each thread always gets its own `Decoration`
 * object here, even when two threads share the exact same range (note that
 * ProseMirror's own DOM renderer may still coalesce two decorations with an
 * identical range into a single wrapping `<span>` for display -- that's a
 * rendering-layer optimization over these two distinct objects, not a merge
 * of them; `data-thread-id` on each keeps them attributable). Exported
 * standalone (rather than inlined in the plugin's `decorations` prop) so
 * this logic is directly unit-testable via `DecorationSet.find()` without
 * depending on ProseMirror's DOM-coalescing behavior.
 */
export function buildCommentDecorations(
	doc: ProseMirrorNode,
	threads: ResolvedThread[],
	focusedThreadId?: string | null,
): Decoration[] {
	const docSize = doc.content.size;
	return threads.flatMap((thread) => {
		if (thread.anchorResolution.status === "orphaned") return [];
		const range = thread.anchorResolution.range;
		if (!range) return [];
		// Defensive clamp: a stale range from a resolution computed against a
		// doc size that has since shrunk must never crash decoration creation.
		if (range.from < 0 || range.to > docSize || range.from >= range.to) {
			return [];
		}
		const classNames = ["pm-comment-mark"];
		if (thread.state === "resolved") {
			classNames.push("pm-comment-mark-resolved");
		}
		if (focusedThreadId != null && thread.id === focusedThreadId) {
			classNames.push("pm-comment-mark-focused");
		}
		return [
			Decoration.inline(range.from, range.to, {
				class: classNames.join(" "),
				"data-thread-id": thread.id,
			}),
		];
	});
}

export type PendingCommentAnchorRange = { from: number; to: number } | null;

export const pendingCommentAnchorKey = new PluginKey<PendingCommentAnchorRange>(
	"pendingCommentAnchor",
);

function sameRange(
	a: PendingCommentAnchorRange,
	b: PendingCommentAnchorRange,
): boolean {
	if (a === b) return true;
	if (!a || !b) return a === b;
	return a.from === b.from && a.to === b.to;
}

/**
 * Imperative setter for the "pending new comment" range: the exact text a
 * just-opened `ThreadPanel` composer is anchored to. Needed because the
 * native selection highlight disappears once focus moves off the document
 * and into the panel's textarea -- this decoration keeps that range visibly
 * highlighted until the draft is posted or cancelled (both clear it back to
 * `null`). Deliberately a separate plugin/key from `commentThreadsKey`: this
 * range has nothing to do with any persisted thread and must not participate
 * in that plugin's thread-list ignition guard. Same guarded-dispatch shape
 * as `setCommentThreads` above, for the same OOM-loop-prevention reason (see
 * that function's doc comment).
 */
export function setPendingCommentAnchor(
	editor: Editor,
	range: PendingCommentAnchorRange,
): void {
	const current = pendingCommentAnchorKey.getState(editor.state) ?? null;
	if (sameRange(current, range)) return;
	editor.view.dispatch(editor.state.tr.setMeta(pendingCommentAnchorKey, range));
}

const pendingCommentAnchorPlugin = new Plugin<PendingCommentAnchorRange>({
	key: pendingCommentAnchorKey,
	state: {
		init: () => null,
		// The panel is non-modal (R21 aside, nothing forces focus to stay in
		// its textarea), so the user can keep editing the document while a
		// draft is open. A raw `{from, to}` capturing a moment in time goes
		// stale the instant any edit lands anywhere in the doc -- including
		// edits nowhere near this range, which shift positions after it.
		// Explicit `setPendingCommentAnchor` meta (a fresh compose session,
		// or a cancel/post clearing it back to null) always wins; absent
		// that, every doc-changing transaction remaps the previous range
		// through `tr.mapping`, the same position-mapping ProseMirror
		// decorations rely on everywhere else. `-1`/`1` associativity keeps
		// text typed right at the anchor's edges outside the highlighted
		// range, matching how a native selection would behave. A change that
		// fully deletes the anchored text collapses `from`/`to` together --
		// clearing to `null` there (instead of carrying forward a
		// zero/negative-width range) is the "recompute or clear on
		// invalidating changes" half of the fix.
		apply: (tr, previous) => {
			const meta = tr.getMeta(pendingCommentAnchorKey) as
				| PendingCommentAnchorRange
				| undefined;
			if (meta !== undefined) return meta;
			if (!previous || !tr.docChanged) return previous;
			const from = tr.mapping.map(previous.from, -1);
			const to = tr.mapping.map(previous.to, 1);
			return from < to ? { from, to } : null;
		},
	},
	props: {
		decorations(state) {
			const range = pendingCommentAnchorKey.getState(state);
			if (!range) return DecorationSet.empty;
			// Defensive clamp mirroring `buildCommentDecorations` above: even
			// with the remap in `apply`, never let a range produce an
			// out-of-bounds `Decoration.inline` call (which throws) -- e.g. a
			// range set via meta before some other, unrelated doc swap.
			const docSize = state.doc.content.size;
			if (range.from < 0 || range.to > docSize || range.from >= range.to) {
				return DecorationSet.empty;
			}
			return DecorationSet.create(state.doc, [
				Decoration.inline(range.from, range.to, {
					class: "pm-comment-mark-pending",
				}),
			]);
		},
	},
});

export const CommentExtension = Extension.create({
	name: "comment",

	addProseMirrorPlugins() {
		return [
			new Plugin<CommentThreadsPluginState>({
				key: commentThreadsKey,
				state: {
					init: () => EMPTY_COMMENT_THREADS_STATE,
					apply: (tr, previous) => {
						const meta = tr.getMeta(commentThreadsKey) as
							| CommentThreadsPluginState
							| undefined;
						return meta !== undefined ? meta : previous;
					},
				},
				props: {
					decorations(state) {
						const pluginState = commentThreadsKey.getState(state);
						if (!pluginState || pluginState.threads.length === 0) {
							return DecorationSet.empty;
						}
						return DecorationSet.create(
							state.doc,
							buildCommentDecorations(
								state.doc,
								pluginState.threads,
								pluginState.focusedThreadId,
							),
						);
					},
				},
			}),
			pendingCommentAnchorPlugin,
		];
	},
});
