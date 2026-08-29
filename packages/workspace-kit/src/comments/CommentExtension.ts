import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { ResolvedThread } from "./useCommentThreads.js";

export const commentThreadsKey = new PluginKey<ResolvedThread[]>("commentThreads");

/**
 * Imperative push of the current resolved thread list into the plugin's
 * state -- the wiring layer (not this slice) calls this whenever
 * `useCommentThreads` produces a new list. Exactly the `FindReplaceExtension`
 * pattern (`findReplaceHighlightKey` + `tr.setMeta`).
 */
export function setCommentThreads(editor: Editor, threads: ResolvedThread[]): void {
	editor.view.dispatch(editor.state.tr.setMeta(commentThreadsKey, threads));
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
		return [
			Decoration.inline(range.from, range.to, {
				class: classNames.join(" "),
				"data-thread-id": thread.id,
			}),
		];
	});
}

export const CommentExtension = Extension.create({
	name: "comment",

	addProseMirrorPlugins() {
		return [
			new Plugin<ResolvedThread[]>({
				key: commentThreadsKey,
				state: {
					init: () => [],
					apply: (tr, previous) => {
						const meta = tr.getMeta(commentThreadsKey) as
							| ResolvedThread[]
							| undefined;
						return meta !== undefined ? meta : previous;
					},
				},
				props: {
					decorations(state) {
						const threads = commentThreadsKey.getState(state);
						if (!threads || threads.length === 0) return DecorationSet.empty;
						return DecorationSet.create(
							state.doc,
							buildCommentDecorations(state.doc, threads),
						);
					},
				},
			}),
		];
	},
});
