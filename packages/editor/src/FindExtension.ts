import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type FindMatch = {
	from: number;
	to: number;
};

export type FindState = {
	query: string;
	activeIndex: number;
	matches: FindMatch[];
};

type FindMeta =
	| { type: "setQuery"; query: string }
	| { type: "setActiveIndex"; activeIndex: number }
	| { type: "clear" };

export const findPluginKey = new PluginKey<FindState>("hubbleFind");

export const FindExtension = Extension.create({
	name: "find",

	addCommands() {
		return {
			setFindQuery:
				(query: string) =>
				({ state, dispatch }) => {
					if (!dispatch) return true;
					dispatch(state.tr.setMeta(findPluginKey, { type: "setQuery", query }));
					return true;
				},
			setFindActiveIndex:
				(activeIndex: number) =>
				({ state, dispatch }) => {
					if (!dispatch) return true;
					dispatch(
						state.tr.setMeta(findPluginKey, { type: "setActiveIndex", activeIndex }),
					);
					return true;
				},
			clearFindQuery:
				() =>
				({ state, dispatch }) => {
					if (!dispatch) return true;
					dispatch(state.tr.setMeta(findPluginKey, { type: "clear" }));
					return true;
				},
		};
	},

	addProseMirrorPlugins() {
		return [
			new Plugin<FindState>({
				key: findPluginKey,
				state: {
					init: (_, state) => emptyFindState(state),
					apply: (tr, previous, _oldState, newState) => {
						const meta = tr.getMeta(findPluginKey) as FindMeta | undefined;
						if (meta?.type === "clear") return emptyFindState(newState);
						const query =
							meta?.type === "setQuery" ? meta.query : previous.query;
						const matches = query.trim()
							? findMatches(newState.doc, query)
							: [];
						const activeIndex =
							meta?.type === "setActiveIndex"
								? normalizeActiveIndex(meta.activeIndex, matches.length)
								: reconcileActiveIndex(previous.activeIndex, matches.length);
						return { query, activeIndex, matches };
					},
				},
				props: {
					decorations: (state) => {
						const findState = findPluginKey.getState(state);
						if (!findState || findState.matches.length === 0) {
							return DecorationSet.empty;
						}
						return DecorationSet.create(
							state.doc,
							findState.matches.map((match, index) =>
								Decoration.inline(match.from, match.to, {
									class:
										index === findState.activeIndex
											? "pm-find-match pm-find-match-current"
											: "pm-find-match",
								}),
							),
						);
					},
				},
			}),
		];
	},
});

export function getFindState(state: EditorState) {
	return findPluginKey.getState(state) ?? emptyFindState(state);
}

export function selectFindMatch(editor: {
	state: EditorState;
	view: { dispatch: (tr: Transaction) => void };
	commands: { scrollIntoView: () => boolean };
}) {
	const findState = getFindState(editor.state);
	const match = findState.matches[findState.activeIndex];
	if (!match) return false;
	const tr = editor.state.tr.setSelection(
		TextSelection.create(editor.state.doc, match.from, match.to),
	);
	editor.view.dispatch(tr);
	editor.commands.scrollIntoView();
	return true;
}

export function findMatches(doc: ProseMirrorNode, query: string) {
	const normalizedQuery = query.toLocaleLowerCase();
	const matches: FindMatch[] = [];
	if (!normalizedQuery) return matches;

	doc.descendants((node, pos) => {
		if (!node.isText || !node.text) return;
		const text = node.text.toLocaleLowerCase();
		let index = text.indexOf(normalizedQuery);
		while (index !== -1) {
			matches.push({
				from: pos + index,
				to: pos + index + query.length,
			});
			index = text.indexOf(normalizedQuery, index + normalizedQuery.length);
		}
	});

	return matches;
}

function emptyFindState(state: EditorState) {
	return {
		query: "",
		activeIndex: 0,
		matches: [],
	};
}

function reconcileActiveIndex(activeIndex: number, matchCount: number) {
	if (matchCount === 0) return 0;
	return Math.min(activeIndex, matchCount - 1);
}

function normalizeActiveIndex(activeIndex: number, matchCount: number) {
	if (matchCount === 0) return 0;
	return ((activeIndex % matchCount) + matchCount) % matchCount;
}

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		find: {
			setFindQuery: (query: string) => ReturnType;
			setFindActiveIndex: (activeIndex: number) => ReturnType;
			clearFindQuery: () => ReturnType;
		};
	}
}
