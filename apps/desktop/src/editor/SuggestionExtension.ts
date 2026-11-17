/**
 * Inline diff review ("suggestions"). Every proposed change — from a writing
 * tool or an agent's `propose_edit` — shows inline at word level: removed
 * words struck through in red, new words highlighted green. Review per change
 * or all at once; next/previous keys; a margin marker on each changed block.
 *
 * One owner: the plugin state below holds the pending changes. Only
 * transactions stamped with this plugin's meta add or drop changes; a doc
 * edit only remaps them, and a change whose original words were edited away
 * is dropped (it no longer describes the text). Accepting is ONE transaction,
 * so it is one undo step; rejecting never touches the document.
 */
import { wordChanges } from "@mdly/agent-hook/diff";
import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
	type EditorState,
	Plugin,
	PluginKey,
	TextSelection,
	type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type SuggestionSource = "agent" | "tool";

export interface SuggestionChange {
	id: string;
	/** Proposal id or tool run id; settles as a unit for reporting. */
	groupId: string;
	source: SuggestionSource;
	from: number;
	to: number;
	before: string;
	insert: string;
	label?: string;
}

export interface SuggestionState {
	changes: SuggestionChange[];
	activeId: string | null;
	/** Changes this transaction dropped because their words were edited away. */
	dropped?: SuggestionChange[];
}

export interface GroupSettled {
	groupId: string;
	source: SuggestionSource;
	accepted: number;
	rejected: number;
	before: string;
	after: string;
}

type Meta =
	| { kind: "add"; changes: SuggestionChange[] }
	| { kind: "remove"; ids: string[] }
	| { kind: "active"; id: string | null };

export const suggestionKey = new PluginKey<SuggestionState>("suggestions");

export function getSuggestions(state: EditorState): SuggestionChange[] {
	return suggestionKey.getState(state)?.changes ?? [];
}

let nextId = 0;
const newId = () => `s${++nextId}`;

/** Maps a plain-text offset inside a textblock to a document position. */
function textOffsetToPos(
	block: ProseMirrorNode,
	blockPos: number,
	offset: number,
): number {
	let remaining = offset;
	let result = blockPos + 1 + block.content.size;
	let found = false;
	block.descendants((node, pos) => {
		if (found) return false;
		if (node.isText && node.text) {
			if (remaining <= node.text.length) {
				result = blockPos + 1 + pos + remaining;
				found = true;
				return false;
			}
			remaining -= node.text.length;
		}
		return true;
	});
	return result;
}

/** Finds `text` inside one textblock; first match at/after `from`. */
export function findTextRange(
	doc: ProseMirrorNode,
	text: string,
): { from: number; to: number } | null {
	if (!text) return null;
	let range: { from: number; to: number } | null = null;
	doc.descendants((node, pos) => {
		if (range) return false;
		if (!node.isTextblock) return true;
		const index = node.textContent.indexOf(text);
		if (index >= 0) {
			range = {
				from: textOffsetToPos(node, pos, index),
				to: textOffsetToPos(node, pos, index + text.length),
			};
		}
		return false;
	});
	return range;
}

/** Splits "replace `[from,to)` with `newText`" into word-level changes. */
export function buildChanges(
	doc: ProseMirrorNode,
	input: {
		groupId: string;
		source: SuggestionSource;
		from: number;
		to: number;
		newText: string;
		label?: string;
	},
): SuggestionChange[] {
	const $from = doc.resolve(input.from);
	const block = $from.parent;
	const blockPos = $from.before();
	const oldText = doc.textBetween(input.from, input.to, "\n");
	const startOffset = doc.textBetween(blockPos + 1, input.from, "\n").length;
	const singleBlock = $from.sameParent(doc.resolve(input.to));
	if (!singleBlock) {
		// Spanning blocks: one coarse change keeps it correct, if less granular.
		return [
			{
				id: newId(),
				groupId: input.groupId,
				source: input.source,
				from: input.from,
				to: input.to,
				before: oldText,
				insert: input.newText,
				label: input.label,
			},
		];
	}
	return wordChanges(oldText, input.newText).map((c) => ({
		id: newId(),
		groupId: input.groupId,
		source: input.source,
		from: textOffsetToPos(block, blockPos, startOffset + c.start),
		to: textOffsetToPos(block, blockPos, startOffset + c.end),
		before: c.before,
		insert: c.after,
		label: input.label,
	}));
}

function mapChanges(state: SuggestionState, tr: Transaction): SuggestionState {
	const changes: SuggestionChange[] = [];
	const dropped: SuggestionChange[] = [];
	for (const change of state.changes) {
		const from = tr.mapping.mapResult(change.from, 1);
		const to = tr.mapping.mapResult(change.to, -1);
		const mapped = {
			...change,
			from: from.pos,
			to: Math.max(from.pos, to.pos),
		};
		if (
			(from.deleted && change.from !== change.to) ||
			tr.doc.textBetween(mapped.from, mapped.to, "\n") !== change.before
		) {
			dropped.push(change);
			continue;
		}
		changes.push(mapped);
	}
	const activeId = changes.some((c) => c.id === state.activeId)
		? state.activeId
		: null;
	return { changes, activeId, dropped };
}

function sorted(changes: SuggestionChange[]) {
	return [...changes].sort((a, b) => a.from - b.from);
}

function decorations(
	state: EditorState,
	value: SuggestionState,
): DecorationSet {
	if (value.changes.length === 0) return DecorationSet.empty;
	const decos: Decoration[] = [];
	const markedBlocks = new Set<number>();
	for (const change of value.changes) {
		const active = change.id === value.activeId ? " is-active" : "";
		if (change.to > change.from) {
			decos.push(
				Decoration.inline(change.from, change.to, {
					class: `mdly-sugg-del${active}`,
					"data-suggestion-id": change.id,
				}),
			);
		}
		if (change.insert) {
			decos.push(
				Decoration.widget(
					change.to,
					() => {
						const span = document.createElement("span");
						span.className = `mdly-sugg-ins${active}`;
						span.dataset.suggestionId = change.id;
						span.textContent = change.insert;
						return span;
					},
					{ side: 1, key: `${change.id}:${change.insert}:${active}` },
				),
			);
		}
		const $pos = state.doc.resolve(change.from);
		if ($pos.depth > 0) {
			const before = $pos.before();
			if (!markedBlocks.has(before)) {
				markedBlocks.add(before);
				decos.push(
					Decoration.node(before, $pos.after(), { class: "mdly-sugg-block" }),
				);
			}
		}
	}
	return DecorationSet.create(state.doc, decos);
}

export interface SuggestionOptions {
	/** Called once every change of a group is accepted or rejected. */
	onGroupSettled?: (settled: GroupSettled) => void;
}

type Settle = (
	before: EditorState,
	removed: SuggestionChange[],
	accepted: boolean,
) => void;

interface Tally {
	accepted: number;
	rejected: number;
	before: string[];
	after: string[];
}

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		suggestions: {
			addSuggestion: (input: {
				groupId: string;
				source: SuggestionSource;
				from: number;
				to: number;
				newText: string;
				label?: string;
			}) => ReturnType;
			acceptSuggestion: (id?: string) => ReturnType;
			rejectSuggestion: (id?: string) => ReturnType;
			acceptAllSuggestions: () => ReturnType;
			rejectAllSuggestions: () => ReturnType;
			nextSuggestion: (direction?: 1 | -1) => ReturnType;
		};
	}
}

function makeSettle(
	tallies: Map<string, Tally>,
	options: SuggestionOptions,
): Settle {
	return (
		before: EditorState,
		removed: SuggestionChange[],
		accepted: boolean,
	) => {
		const removedIds = new Set(removed.map((c) => c.id));
		const remaining = getSuggestions(before).filter(
			(c) => !removedIds.has(c.id),
		);
		for (const change of removed) {
			const tally = tallies.get(change.groupId) ?? {
				accepted: 0,
				rejected: 0,
				before: [],
				after: [],
			};
			if (accepted) tally.accepted++;
			else tally.rejected++;
			tally.before.push(change.before);
			tally.after.push(change.insert);
			tallies.set(change.groupId, tally);
		}
		for (const groupId of new Set(removed.map((c) => c.groupId))) {
			if (remaining.some((c) => c.groupId === groupId)) continue;
			const tally = tallies.get(groupId);
			tallies.delete(groupId);
			if (!tally) continue;
			const source =
				removed.find((c) => c.groupId === groupId)?.source ?? "tool";
			options.onGroupSettled?.({
				groupId,
				source,
				accepted: tally.accepted,
				rejected: tally.rejected,
				before: tally.before.join(" "),
				after: tally.after.join(" "),
			});
		}
	};
}

export const SuggestionExtension = Extension.create<
	SuggestionOptions,
	{ tallies: Map<string, Tally> }
>({
	name: "suggestions",

	addOptions() {
		return { onGroupSettled: undefined };
	},

	addStorage() {
		return { tallies: new Map<string, Tally>() };
	},

	addProseMirrorPlugins() {
		return [
			new Plugin<SuggestionState>({
				key: suggestionKey,
				state: {
					init: () => ({ changes: [], activeId: null }),
					apply(tr, value) {
						let next = tr.docChanged
							? mapChanges(value, tr)
							: { ...value, dropped: undefined };
						const meta = tr.getMeta(suggestionKey) as Meta | undefined;
						if (meta?.kind === "add") {
							next = {
								changes: sorted([...next.changes, ...meta.changes]),
								activeId: next.activeId ?? meta.changes[0]?.id ?? null,
							};
						} else if (meta?.kind === "remove") {
							const ids = new Set(meta.ids);
							const changes = next.changes.filter((c) => !ids.has(c.id));
							const activeId =
								next.activeId && ids.has(next.activeId)
									? (changes[0]?.id ?? null)
									: next.activeId;
							// Accepted changes edit their own words; they settle via the command, not as dropped.
							const dropped = next.dropped?.filter((c) => !ids.has(c.id));
							next = { changes, activeId, dropped };
						} else if (meta?.kind === "active") {
							next = { ...next, activeId: meta.id };
						}
						return next;
					},
				},
				// A change edited away still settles (as rejected), so the agent
				// hears back and the proposal stops being pending.
				view: () => ({
					update: (view) => {
						const dropped = suggestionKey.getState(view.state)?.dropped;
						if (dropped?.length)
							makeSettle(this.storage.tallies, this.options)(
								view.state,
								dropped,
								false,
							);
					},
				}),
				props: {
					decorations(state) {
						return decorations(
							state,
							suggestionKey.getState(state) ?? { changes: [], activeId: null },
						);
					},
					handleClick(view, pos) {
						const hit = getSuggestions(view.state).find(
							(c) => pos >= c.from && pos <= c.to,
						);
						if (!hit) return false;
						view.dispatch(
							view.state.tr.setMeta(suggestionKey, {
								kind: "active",
								id: hit.id,
							} satisfies Meta),
						);
						return false;
					},
				},
			}),
		];
	},

	addCommands() {
		const settle = makeSettle(this.storage.tallies, this.options);
		const pick = (state: EditorState, id?: string) => {
			const all = getSuggestions(state);
			const wanted = id ?? suggestionKey.getState(state)?.activeId;
			return all.find((c) => c.id === wanted) ?? all[0];
		};
		const apply = (tr: Transaction, changes: SuggestionChange[]) => {
			// Descending so earlier positions stay valid.
			for (const c of [...changes].sort((a, b) => b.from - a.from)) {
				if (c.insert) tr.insertText(c.insert, c.from, c.to);
				else tr.delete(c.from, c.to);
			}
		};
		return {
			addSuggestion:
				(input) =>
				({ state, tr, dispatch }) => {
					if (
						input.from < 0 ||
						input.to > state.doc.content.size ||
						input.from > input.to
					)
						return false;
					const changes = buildChanges(state.doc, input);
					if (changes.length === 0) return false;
					if (dispatch)
						tr.setMeta(suggestionKey, {
							kind: "add",
							changes,
						} satisfies Meta).setMeta("addToHistory", false);
					return true;
				},
			acceptSuggestion:
				(id) =>
				({ state, tr, dispatch }) => {
					const change = pick(state, id);
					if (!change) return false;
					if (dispatch) {
						apply(tr, [change]);
						tr.setMeta(suggestionKey, {
							kind: "remove",
							ids: [change.id],
						} satisfies Meta);
						settle(state, [change], true);
					}
					return true;
				},
			rejectSuggestion:
				(id) =>
				({ state, tr, dispatch }) => {
					const change = pick(state, id);
					if (!change) return false;
					if (dispatch) {
						tr.setMeta(suggestionKey, {
							kind: "remove",
							ids: [change.id],
						} satisfies Meta).setMeta("addToHistory", false);
						settle(state, [change], false);
					}
					return true;
				},
			acceptAllSuggestions:
				() =>
				({ state, tr, dispatch }) => {
					const all = getSuggestions(state);
					if (all.length === 0) return false;
					if (dispatch) {
						apply(tr, all);
						tr.setMeta(suggestionKey, {
							kind: "remove",
							ids: all.map((c) => c.id),
						} satisfies Meta);
						settle(state, all, true);
					}
					return true;
				},
			rejectAllSuggestions:
				() =>
				({ state, tr, dispatch }) => {
					const all = getSuggestions(state);
					if (all.length === 0) return false;
					if (dispatch) {
						tr.setMeta(suggestionKey, {
							kind: "remove",
							ids: all.map((c) => c.id),
						} satisfies Meta).setMeta("addToHistory", false);
						settle(state, all, false);
					}
					return true;
				},
			nextSuggestion:
				(direction = 1) =>
				({ state, tr, dispatch }) => {
					const all = getSuggestions(state);
					if (all.length === 0) return false;
					const head = state.selection.head;
					const target =
						direction === 1
							? (all.find((c) => c.from > head) ?? all[0])
							: ([...all].reverse().find((c) => c.to < head) ??
								all[all.length - 1]);
					if (dispatch) {
						tr.setSelection(TextSelection.create(tr.doc, target.from))
							.setMeta(suggestionKey, {
								kind: "active",
								id: target.id,
							} satisfies Meta)
							.scrollIntoView();
					}
					return true;
				},
		};
	},

	addKeyboardShortcuts() {
		const has = () => getSuggestions(this.editor.state).length > 0;
		return {
			"Mod-Alt-]": () => has() && this.editor.commands.nextSuggestion(1),
			"Mod-Alt-[": () => has() && this.editor.commands.nextSuggestion(-1),
			"Mod-Alt-Enter": () => has() && this.editor.commands.acceptSuggestion(),
			"Mod-Alt-Backspace": () =>
				has() && this.editor.commands.rejectSuggestion(),
		};
	},
});
