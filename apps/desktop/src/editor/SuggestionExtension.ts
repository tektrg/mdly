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
import {
	DOMSerializer,
	Fragment,
	type Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import {
	type EditorState,
	Plugin,
	PluginKey,
	TextSelection,
	type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type SuggestionSource = "agent" | "tool" | "external";

export type SuggestionKind =
	| "inline"
	| "block-add"
	| "block-del"
	| "block-replace";

export interface SuggestionChange {
	id: string;
	/** Proposal id, tool run id, or external change id; settles as a unit. */
	groupId: string;
	source: SuggestionSource;
	/**
	 * When true, the change is already applied in the document (e.g. an external
	 * disk edit): Accept keeps it as-is, Reject reverts it back to `before` /
	 * `deletedNodes`.
	 */
	applied?: boolean;
	kind?: SuggestionKind;
	from: number;
	to: number;
	before: string;
	insert: string;
	/** Original ProseMirror block(s) to restore when undoing block-del / block-replace. */
	deletedNodes?: ProseMirrorNode[];
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
	| {
			kind: "replace-source";
			source: SuggestionSource;
			changes: SuggestionChange[];
	  }
	| { kind: "clear-source"; source: SuggestionSource }
	| { kind: "remove"; ids: string[] }
	| { kind: "active"; id: string | null };

export const suggestionKey = new PluginKey<SuggestionState>("suggestions");

export function getSuggestions(state: EditorState): SuggestionChange[] {
	return suggestionKey.getState(state)?.changes ?? [];
}

let nextId = 0;
export const newSuggestionId = () => `s${++nextId}`;
const newId = newSuggestionId;

/** Maps a plain-text offset inside a textblock to a document position. */
export function textOffsetToPos(
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

/** Every match of `text` (each within one textblock), in document order. */
export function findAllTextRanges(
	doc: ProseMirrorNode,
	text: string,
): { from: number; to: number }[] {
	const ranges: { from: number; to: number }[] = [];
	if (!text) return ranges;
	doc.descendants((node, pos) => {
		if (!node.isTextblock) return true;
		const content = node.textContent;
		for (
			let index = content.indexOf(text);
			index >= 0;
			index = content.indexOf(text, index + 1)
		) {
			ranges.push({
				from: textOffsetToPos(node, pos, index),
				to: textOffsetToPos(node, pos, index + text.length),
			});
		}
		return false;
	});
	return ranges;
}

export type Placement =
	| { ok: true; from: number; to: number }
	| {
			ok: false;
			reason: "not-found" | "ambiguous" | "occurrence-out-of-range";
			message: string;
	  };

/**
 * Where an agent proposal goes. Never guesses: a `find` matching several
 * places needs an `occurrence` (1-based); otherwise it is rejected with a
 * reason the agent can act on.
 */
export function placeProposal(
	doc: ProseMirrorNode,
	proposal: { find: string; occurrence?: number },
): Placement {
	const ranges = findAllTextRanges(doc, proposal.find);
	if (ranges.length === 0)
		return {
			ok: false,
			reason: "not-found",
			message: "The text to replace is no longer in the note.",
		};
	if (proposal.occurrence !== undefined) {
		const range = ranges[proposal.occurrence - 1];
		if (!range)
			return {
				ok: false,
				reason: "occurrence-out-of-range",
				message: `Asked for match ${proposal.occurrence}, but the text appears ${ranges.length} time${ranges.length === 1 ? "" : "s"}.`,
			};
		return { ok: true, ...range };
	}
	if (ranges.length > 1)
		return {
			ok: false,
			reason: "ambiguous",
			message: `The text appears in ${ranges.length} places; say which (occurrence 1-${ranges.length}) or use a longer, unique find.`,
		};
	return { ok: true, ...ranges[0] };
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
		const kind = change.kind ?? "inline";
		if (kind === "block-del") {
			const mappedPos = tr.mapping.mapResult(change.from, -1);
			if (mappedPos.deleted) {
				dropped.push(change);
				continue;
			}
			changes.push({ ...change, from: mappedPos.pos, to: mappedPos.pos });
			continue;
		}
		const from = tr.mapping.mapResult(change.from, 1);
		const to = tr.mapping.mapResult(change.to, -1);
		const mapped = {
			...change,
			from: from.pos,
			to: Math.max(from.pos, to.pos),
		};
		if (kind === "block-add" || kind === "block-replace") {
			if (from.deleted || mapped.from >= mapped.to) {
				dropped.push(change);
				continue;
			}
			changes.push(mapped);
			continue;
		}
		const expectedInDoc = change.applied ? change.insert : change.before;
		if (
			(from.deleted && change.from !== change.to) ||
			tr.doc.textBetween(mapped.from, mapped.to, "\n") !== expectedInDoc
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

function makeDeletedBlockWidget(
	state: EditorState,
	change: SuggestionChange,
	active: string,
): Decoration {
	return Decoration.widget(
		change.from,
		() => {
			const nodes = change.deletedNodes;
			if (nodes && nodes.length > 0) {
				const serializer = DOMSerializer.fromSchema(state.doc.type.schema);
				// A deleted tableRow lives directly inside <tbody>, so return a real
				// <tr> element instead of wrapping it in a <div>.
				if (nodes.length === 1 && nodes[0].type.name === "tableRow") {
					const rowEl = serializer.serializeNode(nodes[0]);
					if (rowEl instanceof HTMLElement) {
						rowEl.classList.add("mdly-sugg-row-del");
						if (active) rowEl.classList.add("is-active");
						rowEl.dataset.suggestionId = change.id;
						return rowEl;
					}
				}
				const div = document.createElement("div");
				div.className = `mdly-sugg-block-del${active}`;
				div.dataset.suggestionId = change.id;
				div.appendChild(serializer.serializeFragment(Fragment.from(nodes)));
				return div;
			}
			const div = document.createElement("div");
			div.className = `mdly-sugg-block-del${active}`;
			div.dataset.suggestionId = change.id;
			div.textContent = change.before;
			return div;
		},
		{ side: -1, key: `${change.id}:del-block:${active}` },
	);
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
		const kind = change.kind ?? "inline";

		if (kind === "block-add") {
			if (change.to > change.from) {
				decos.push(
					Decoration.node(change.from, change.to, {
						class: `mdly-sugg-block-ins${active}`,
						"data-suggestion-id": change.id,
					}),
				);
			}
			continue;
		}

		if (kind === "block-del") {
			decos.push(makeDeletedBlockWidget(state, change, active));
			continue;
		}

		if (kind === "block-replace") {
			if (change.before || change.deletedNodes?.length) {
				decos.push(makeDeletedBlockWidget(state, change, active));
			}
			if (change.to > change.from) {
				decos.push(
					Decoration.node(change.from, change.to, {
						class: `mdly-sugg-block-ins${active}`,
						"data-suggestion-id": change.id,
					}),
				);
			}
			continue;
		}

		if (change.applied) {
			if (change.before) {
				decos.push(
					Decoration.widget(
						change.from,
						() => {
							const span = document.createElement("span");
							span.className = `mdly-sugg-del${active}`;
							span.dataset.suggestionId = change.id;
							span.textContent = change.before;
							return span;
						},
						{ side: -1, key: `${change.id}:del:${change.before}:${active}` },
					),
				);
			}
			if (change.to > change.from) {
				decos.push(
					Decoration.inline(change.from, change.to, {
						class: `mdly-sugg-ins${active}`,
						"data-suggestion-id": change.id,
					}),
				);
			}
		} else {
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
			setAppliedSuggestions: (
				source: SuggestionSource,
				changes: SuggestionChange[],
			) => ReturnType;
			clearSuggestionsBySource: (source: SuggestionSource) => ReturnType;
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
						} else if (meta?.kind === "replace-source") {
							const kept = next.changes.filter((c) => c.source !== meta.source);
							const changes = sorted([...kept, ...meta.changes]);
							const activeId = changes.some((c) => c.id === next.activeId)
								? next.activeId
								: (changes[0]?.id ?? null);
							next = { changes, activeId };
						} else if (meta?.kind === "clear-source") {
							const changes = next.changes.filter(
								(c) => c.source !== meta.source,
							);
							const activeId = changes.some((c) => c.id === next.activeId)
								? next.activeId
								: (changes[0]?.id ?? null);
							next = { changes, activeId };
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
					handleClick(view, pos, event) {
						const targetEl =
							event.target instanceof Element
								? event.target.closest("[data-suggestion-id]")
								: null;
						const targetId = targetEl?.getAttribute("data-suggestion-id");
						const hit = targetId
							? getSuggestions(view.state).find((c) => c.id === targetId)
							: getSuggestions(view.state).find(
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
		const applyProposed = (tr: Transaction, changes: SuggestionChange[]) => {
			// Descending so earlier positions stay valid.
			for (const c of [...changes].sort((a, b) => b.from - a.from)) {
				if (c.insert) tr.insertText(c.insert, c.from, c.to);
				else tr.delete(c.from, c.to);
			}
		};
		const revertApplied = (tr: Transaction, changes: SuggestionChange[]) => {
			// Ascending by position, then iterate in reverse so earlier positions
			// stay valid AND multiple deletions at the same anchor restore in order.
			const ordered = [...changes].sort((a, b) => a.from - b.from);
			for (let i = ordered.length - 1; i >= 0; i--) {
				const c = ordered[i];
				const kind = c.kind ?? "inline";
				if (kind === "block-add") {
					if (c.from === 0 && c.to === tr.doc.content.size) {
						const para = tr.doc.type.schema.nodes.paragraph?.create();
						if (para) tr.replaceWith(c.from, c.to, para);
					} else {
						tr.delete(c.from, c.to);
					}
				} else if (kind === "block-del") {
					if (c.deletedNodes && c.deletedNodes.length > 0) {
						tr.insert(c.from, c.deletedNodes);
					}
				} else if (kind === "block-replace") {
					if (c.deletedNodes && c.deletedNodes.length > 0) {
						tr.replaceWith(c.from, c.to, c.deletedNodes);
					}
				} else {
					if (c.before) tr.insertText(c.before, c.from, c.to);
					else tr.delete(c.from, c.to);
				}
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
			setAppliedSuggestions:
				(source, changes) =>
				({ tr, dispatch }) => {
					if (dispatch)
						tr.setMeta(suggestionKey, {
							kind: "replace-source",
							source,
							changes,
						} satisfies Meta).setMeta("addToHistory", false);
					return true;
				},
			clearSuggestionsBySource:
				(source) =>
				({ tr, dispatch }) => {
					if (dispatch)
						tr.setMeta(suggestionKey, {
							kind: "clear-source",
							source,
						} satisfies Meta).setMeta("addToHistory", false);
					return true;
				},
			acceptSuggestion:
				(id) =>
				({ state, tr, dispatch }) => {
					const change = pick(state, id);
					if (!change) return false;
					if (dispatch) {
						if (!change.applied) {
							applyProposed(tr, [change]);
						} else {
							tr.setMeta("addToHistory", false);
						}
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
						if (change.applied) {
							revertApplied(tr, [change]);
						} else {
							tr.setMeta("addToHistory", false);
						}
						tr.setMeta(suggestionKey, {
							kind: "remove",
							ids: [change.id],
						} satisfies Meta);
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
						const proposed = all.filter((c) => !c.applied);
						if (proposed.length > 0) applyProposed(tr, proposed);
						else tr.setMeta("addToHistory", false);
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
						const applied = all.filter((c) => c.applied);
						if (applied.length > 0) revertApplied(tr, applied);
						else tr.setMeta("addToHistory", false);
						tr.setMeta(suggestionKey, {
							kind: "remove",
							ids: all.map((c) => c.id),
						} satisfies Meta);
						settle(state, all, false);
					}
					return true;
				},
			nextSuggestion:
				(direction = 1) =>
				({ editor, state, tr, dispatch, view }) => {
					const all = getSuggestions(state);
					if (all.length === 0) return false;
					const activeId = suggestionKey.getState(state)?.activeId;
					const currentIndex = activeId
						? all.findIndex((c) => c.id === activeId)
						: -1;
					const head = state.selection.head;
					const active = currentIndex >= 0 ? all[currentIndex] : null;
					const caretOnActive =
						active !== null && head >= active.from && head <= active.to;
					let target: SuggestionChange;
					if (currentIndex >= 0 && (!editor.isEditable || caretOnActive)) {
						target = all[(currentIndex + direction + all.length) % all.length];
					} else {
						target =
							direction === 1
								? (all.find((c) => c.from > head) ?? all[0])
								: ([...all].reverse().find((c) => c.to < head) ??
									all[all.length - 1]);
					}
					if (dispatch) {
						const clamped = Math.max(
							0,
							Math.min(target.from, tr.doc.content.size),
						);
						tr.setSelection(TextSelection.near(tr.doc.resolve(clamped)))
							.setMeta(suggestionKey, {
								kind: "active",
								id: target.id,
							} satisfies Meta)
							.scrollIntoView();
						// ProseMirror's scrollIntoView() is a no-op when the editor is
						// non-editable (version history) or blurred (toolbar button click).
						// Explicitly scroll the active suggestion DOM node into view.
						if (typeof requestAnimationFrame === "function") {
							requestAnimationFrame(() => {
								if (view.isDestroyed) return;
								const el = view.dom.querySelector(
									`[data-suggestion-id="${target.id}"]`,
								);
								el?.scrollIntoView({ behavior: "smooth", block: "center" });
							});
						}
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
