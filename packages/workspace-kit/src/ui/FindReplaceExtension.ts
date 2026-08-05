import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { TextMatch } from "./findReplace";

export type FindReplaceHighlightState = {
	matches: TextMatch[];
	activeIndex: number;
};

type FindReplaceHighlightMeta = FindReplaceHighlightState | null;

export const findReplaceHighlightKey =
	new PluginKey<FindReplaceHighlightState | null>("findReplaceHighlight");

export const FindReplaceExtension = Extension.create({
	name: "findReplace",

	addProseMirrorPlugins() {
		return [
			new Plugin<FindReplaceHighlightState | null>({
				key: findReplaceHighlightKey,
				state: {
					init: () => null,
					apply: (tr, previous) => {
						const meta = tr.getMeta(findReplaceHighlightKey) as
							| FindReplaceHighlightMeta
							| undefined;
						if (meta !== undefined) return meta;
						if (!previous) return null;
						if (!tr.docChanged) return previous;
						const mapped = previous.matches
							.map((match) => ({
								...match,
								from: tr.mapping.map(match.from),
								to: tr.mapping.map(match.to),
							}))
							.filter((match) => match.from < match.to);
						return {
							matches: mapped,
							activeIndex:
								mapped.length === 0
									? -1
									: Math.min(previous.activeIndex, mapped.length - 1),
						};
					},
				},
				props: {
					decorations(state) {
						const data = findReplaceHighlightKey.getState(state);
						if (!data || data.matches.length === 0) {
							return DecorationSet.empty;
						}
						const decorations = data.matches.map((match, index) =>
							Decoration.inline(match.from, match.to, {
								class:
									index === data.activeIndex
										? "pm-find-match pm-find-match-active"
										: "pm-find-match",
							}),
						);
						return DecorationSet.create(state.doc, decorations);
					},
				},
			}),
		];
	},
});
