import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
	type EditorState,
	Plugin,
	PluginKey,
	Selection,
	TextSelection,
	type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
	findDocumentTextMatches,
	matchIndexAfterPosition,
} from "./findReplace";

/**
 * Sublime-style multiple selections (Cmd+D / Cmd+Shift+L).
 *
 * One owner: the plugin state below. `null` = feature inactive. While active,
 * `ranges[primary]` mirrors the real ProseMirror selection (drawn natively);
 * every other range is drawn as a decoration. Only transactions stamped with
 * this plugin's meta may change the ranges; any other selection change or doc
 * edit (Enter, click, formatting, IME, undo) collapses back to the primary.
 * Transactions appended by other plugins only remap the ranges.
 */
export type SelectionRange = { anchor: number; head: number };

export type MultiSelectionState = {
	ranges: SelectionRange[];
	primary: number;
	/** Set when the session began by expanding a caret to a word (Cmd+D). */
	wholeWord: boolean;
} | null;

export const multiSelectionKey = new PluginKey<MultiSelectionState>(
	"multiSelection",
);

const rangeFrom = (r: SelectionRange) => Math.min(r.anchor, r.head);
const rangeTo = (r: SelectionRange) => Math.max(r.anchor, r.head);
const WORD_CHAR = /[\p{L}\p{N}_]/u;

export function getMultiSelectionRanges(state: EditorState) {
	return multiSelectionKey.getState(state)?.ranges ?? [];
}

function isMulti(state: EditorState) {
	return getMultiSelectionRanges(state).length > 1;
}

/**
 * Sorts, then merges overlapping (or identical) ranges, keeping track of
 * which merged range holds the primary.
 */
export function normalizeRanges(
	ranges: SelectionRange[],
	primary: number,
): { ranges: SelectionRange[]; primary: number } {
	const indexed = ranges.map((range, index) => ({ range, index }));
	indexed.sort(
		(a, b) =>
			rangeFrom(a.range) - rangeFrom(b.range) ||
			rangeTo(a.range) - rangeTo(b.range),
	);
	const out: { range: SelectionRange; hasPrimary: boolean }[] = [];
	for (const { range, index } of indexed) {
		const last = out[out.length - 1];
		const isPrimary = index === primary;
		if (
			last &&
			(rangeFrom(range) < rangeTo(last.range) ||
				(rangeFrom(range) === rangeFrom(last.range) &&
					rangeTo(range) === rangeTo(last.range)) ||
				(rangeFrom(range) === rangeTo(last.range) &&
					(rangeFrom(range) === rangeTo(range) ||
						rangeFrom(last.range) === rangeTo(last.range))))
		) {
			const from = Math.min(rangeFrom(last.range), rangeFrom(range));
			const to = Math.max(rangeTo(last.range), rangeTo(range));
			const forward = range.head >= range.anchor;
			last.range = forward
				? { anchor: from, head: to }
				: { anchor: to, head: from };
			last.hasPrimary ||= isPrimary;
			continue;
		}
		out.push({ range, hasPrimary: isPrimary });
	}
	const primaryIndex = Math.max(
		0,
		out.findIndex((entry) => entry.hasPrimary),
	);
	return { ranges: out.map((entry) => entry.range), primary: primaryIndex };
}

/** Applies the new ranges: plugin meta + the real selection on the primary. */
function commitRanges(
	tr: Transaction,
	ranges: SelectionRange[],
	primary: number,
	wholeWord: boolean,
) {
	const normalized = normalizeRanges(ranges, primary);
	const main = normalized.ranges[normalized.primary];
	if (main) {
		tr.setSelection(TextSelection.create(tr.doc, main.anchor, main.head));
	}
	tr.setMeta(multiSelectionKey, {
		ranges: normalized.ranges,
		primary: normalized.primary,
		wholeWord,
	} satisfies MultiSelectionState);
	return tr;
}

function textBlockRange(doc: ProseMirrorNode, from: number, to: number) {
	const $from = doc.resolve(from);
	const $to = doc.resolve(to);
	if (!$from.parent.isTextblock || !$from.sameParent($to)) return null;
	return $from;
}

function wordAt(doc: ProseMirrorNode, pos: number) {
	const $pos = doc.resolve(pos);
	if (!$pos.parent.isTextblock) return null;
	const start = $pos.start();
	// Leaf inline nodes become a non-word placeholder so offsets line up.
	const text = $pos.parent.textBetween(0, $pos.parent.content.size, "\n", "\n");
	let left = $pos.parentOffset;
	let right = $pos.parentOffset;
	while (left > 0 && WORD_CHAR.test(text[left - 1] ?? "")) left--;
	while (right < text.length && WORD_CHAR.test(text[right] ?? "")) right++;
	if (left === right) return null;
	return { from: start + left, to: start + right };
}

function isWholeWordAt(doc: ProseMirrorNode, from: number, to: number) {
	const $from = doc.resolve(from);
	const before = $from.parentOffset > 0 ? doc.textBetween(from - 1, from) : "";
	const $to = doc.resolve(to);
	const after =
		$to.parentOffset < $to.parent.content.size
			? doc.textBetween(to, to + 1)
			: "";
	return !WORD_CHAR.test(before) && !WORD_CHAR.test(after);
}

function initialState(state: EditorState): {
	ranges: SelectionRange[];
	primary: number;
	wholeWord: boolean;
} | null {
	const current = multiSelectionKey.getState(state);
	if (current) return current;
	const { selection } = state;
	if (!(selection instanceof TextSelection)) return null;
	return {
		ranges: [{ anchor: selection.anchor, head: selection.head }],
		primary: 0,
		wholeWord: false,
	};
}

/** Finds every case-sensitive occurrence of `query` matching the session mode. */
function matchesFor(doc: ProseMirrorNode, query: string, wholeWord: boolean) {
	return findDocumentTextMatches(doc, query, { caseSensitive: true }).filter(
		(match) => !wholeWord || isWholeWordAt(doc, match.from, match.to),
	);
}

/** Expands an empty primary caret to its word. Returns true if handled. */
function expandCaretToWord(
	state: EditorState,
	dispatch: (tr: Transaction) => void,
): boolean {
	const word = wordAt(state.doc, state.selection.head);
	if (!word) return true;
	dispatch(
		commitRanges(
			state.tr,
			[{ anchor: word.from, head: word.to }],
			0,
			true,
		).scrollIntoView(),
	);
	return true;
}

/** Cmd+D. */
export function addNextOccurrence(
	state: EditorState,
	dispatch: (tr: Transaction) => void,
): boolean {
	const session = initialState(state);
	if (!session) return false;
	const primaryRange = session.ranges[session.primary];
	if (!primaryRange) return false;
	if (rangeFrom(primaryRange) === rangeTo(primaryRange)) {
		if (session.ranges.length > 1) return true;
		return expandCaretToWord(state, dispatch);
	}
	if (
		!textBlockRange(state.doc, rangeFrom(primaryRange), rangeTo(primaryRange))
	)
		return true;
	const query = state.doc.textBetween(
		rangeFrom(primaryRange),
		rangeTo(primaryRange),
	);
	const matches = matchesFor(state.doc, query, session.wholeWord);
	if (matches.length === 0) return true;
	const taken = new Set(
		session.ranges.map((range) => `${rangeFrom(range)}:${rangeTo(range)}`),
	);
	const start = matchIndexAfterPosition(matches, rangeTo(primaryRange));
	for (let step = 0; step < matches.length; step++) {
		const match = matches[(start + step) % matches.length];
		if (!match || taken.has(`${match.from}:${match.to}`)) continue;
		const ranges = [...session.ranges, { anchor: match.from, head: match.to }];
		const tr = commitRanges(
			state.tr,
			ranges,
			ranges.length - 1,
			session.wholeWord,
		);
		dispatch(tr.scrollIntoView());
		return true;
	}
	return true;
}

/** Cmd+Shift+L: every occurrence of the primary selection's text. */
export function selectAllOccurrences(
	state: EditorState,
	dispatch: (tr: Transaction) => void,
): boolean {
	const session = initialState(state);
	if (!session) return false;
	let primaryRange = session.ranges[session.primary];
	if (!primaryRange) return false;
	let wholeWord = session.wholeWord;
	if (rangeFrom(primaryRange) === rangeTo(primaryRange)) {
		if (session.ranges.length > 1) return true;
		const word = wordAt(state.doc, primaryRange.head);
		if (!word) return true;
		primaryRange = { anchor: word.from, head: word.to };
		wholeWord = true;
	}
	if (
		!textBlockRange(state.doc, rangeFrom(primaryRange), rangeTo(primaryRange))
	)
		return true;
	const query = state.doc.textBetween(
		rangeFrom(primaryRange),
		rangeTo(primaryRange),
	);
	const matches = matchesFor(state.doc, query, wholeWord);
	if (matches.length === 0) return true;
	const primaryFrom = rangeFrom(primaryRange);
	const ranges = matches.map((m) => ({ anchor: m.from, head: m.to }));
	const primary = Math.max(
		0,
		matches.findIndex((m) => m.from === primaryFrom),
	);
	dispatch(commitRanges(state.tr, ranges, primary, wholeWord));
	return true;
}

/** Esc: drop the extras. Returns false when there is nothing to collapse. */
export function collapseToPrimary(
	state: EditorState,
	dispatch: (tr: Transaction) => void,
): boolean {
	if (!isMulti(state)) return false;
	dispatch(state.tr.setMeta(multiSelectionKey, null));
	return true;
}

type RangeEdit = (
	tr: Transaction,
	from: number,
	to: number,
) => { from: number; to: number } | null;

/**
 * Applies one edit per range, last range first so earlier positions stay
 * valid, all inside a single transaction (= a single undo step). Each range
 * ends as a caret at the mapped end of its edit.
 */
function editAllRanges(
	state: EditorState,
	dispatch: (tr: Transaction) => void,
	edit: RangeEdit,
): boolean {
	const session = multiSelectionKey.getState(state);
	if (!session || session.ranges.length < 2) return false;
	const tr = state.tr;
	const ordered = session.ranges
		.map((range, index) => ({ range, index }))
		.sort((a, b) => rangeFrom(b.range) - rangeFrom(a.range));
	const ends: { index: number; pos: number; stepsAfter: number }[] = [];
	for (const { range, index } of ordered) {
		const result = edit(tr, rangeFrom(range), rangeTo(range));
		ends.push({
			index,
			pos: result ? result.to : rangeTo(range),
			stepsAfter: tr.steps.length,
		});
	}
	const next: SelectionRange[] = session.ranges.map(() => ({
		anchor: 0,
		head: 0,
	}));
	for (const end of ends) {
		// Only edits made later (at earlier document positions) shift it.
		const pos = tr.mapping.slice(end.stepsAfter).map(end.pos, 1);
		next[end.index] = { anchor: pos, head: pos };
	}
	commitRanges(tr, next, session.primary, session.wholeWord);
	dispatch(tr.scrollIntoView());
	return true;
}

export function insertTextAtAllRanges(
	state: EditorState,
	dispatch: (tr: Transaction) => void,
	text: string,
): boolean {
	return editAllRanges(state, dispatch, (tr, from, to) => {
		// insertText without stored marks inherits the marks at `from`.
		tr.insertText(text, from, to);
		return { from, to: from + text.length };
	});
}

export function deleteAtAllRanges(
	state: EditorState,
	dispatch: (tr: Transaction) => void,
	direction: -1 | 1,
): boolean {
	return editAllRanges(state, dispatch, (tr, from, to) => {
		if (from !== to) {
			tr.delete(from, to);
			return { from, to: from };
		}
		const $pos = tr.doc.resolve(from);
		if (!$pos.parent.isTextblock) return null;
		// Never join blocks from a secondary caret; stay inside the block.
		if (direction < 0 && $pos.parentOffset === 0) return { from, to: from };
		if (direction > 0 && $pos.parentOffset === $pos.parent.content.size)
			return { from, to: from };
		const start = direction < 0 ? from - 1 : from;
		tr.delete(start, start + 1);
		return { from: start, to: start };
	});
}

type Move = "char" | "word" | "line" | "vertical";

function moveHead(
	view: EditorView,
	doc: ProseMirrorNode,
	head: number,
	dir: -1 | 1,
	move: Move,
): number {
	if (move === "vertical") return moveVertical(view, doc, head, dir);
	const $head = doc.resolve(head);
	if ($head.parent.isTextblock) {
		const offset = $head.parentOffset;
		const size = $head.parent.content.size;
		if (move === "line") return dir < 0 ? $head.start() : $head.end();
		if (move === "word" && (dir < 0 ? offset > 0 : offset < size)) {
			const text = $head.parent.textBetween(0, size, "\n", "\n");
			let i = offset;
			if (dir < 0) {
				while (i > 0 && !WORD_CHAR.test(text[i - 1] ?? "")) i--;
				while (i > 0 && WORD_CHAR.test(text[i - 1] ?? "")) i--;
			} else {
				while (i < size && !WORD_CHAR.test(text[i] ?? "")) i++;
				while (i < size && WORD_CHAR.test(text[i] ?? "")) i++;
			}
			return $head.start() + i;
		}
		if (dir < 0 ? offset > 0 : offset < size) return head + dir;
	}
	const target = Math.max(0, Math.min(doc.content.size, head + dir));
	return Selection.near(doc.resolve(target), dir).head;
}

function moveVertical(
	view: EditorView,
	doc: ProseMirrorNode,
	head: number,
	dir: -1 | 1,
): number {
	try {
		const coords = view.coordsAtPos(head);
		const lineHeight = Math.max(coords.bottom - coords.top, 1);
		const top =
			dir < 0 ? coords.top - lineHeight / 2 : coords.bottom + lineHeight / 2;
		const found = view.posAtCoords({ left: coords.left, top });
		if (!found || found.pos === head) {
			return dir < 0 ? Selection.atStart(doc).head : Selection.atEnd(doc).head;
		}
		return Selection.near(doc.resolve(found.pos), dir).head;
	} catch {
		return head;
	}
}

/** Arrow keys: move (or with `extend`, grow) every range at once. */
export function moveAllRanges(
	view: EditorView,
	dir: -1 | 1,
	move: Move,
	extend: boolean,
): boolean {
	const { state } = view;
	const session = multiSelectionKey.getState(state);
	if (!session || session.ranges.length < 2) return false;
	const ranges = session.ranges.map((range) => {
		const empty = range.anchor === range.head;
		if (!extend && !empty && move === "char") {
			const pos = dir < 0 ? rangeFrom(range) : rangeTo(range);
			return { anchor: pos, head: pos };
		}
		const origin = extend
			? range.head
			: dir < 0
				? rangeFrom(range)
				: rangeTo(range);
		const head = moveHead(view, state.doc, origin, dir, move);
		return { anchor: extend ? range.anchor : head, head };
	});
	view.dispatch(
		commitRanges(
			state.tr,
			ranges,
			session.primary,
			session.wholeWord,
		).scrollIntoView(),
	);
	return true;
}

/** Plain-text paste at every range (bypasses markdown paste). */
export function handleMultiSelectionPaste(
	view: EditorView,
	event: ClipboardEvent,
): boolean {
	if (!isMulti(view.state)) return false;
	const text = event.clipboardData?.getData("text/plain") ?? "";
	if (!text) return true;
	event.preventDefault();
	return insertTextAtAllRanges(view.state, view.dispatch, text);
}

const ARROWS: Record<string, { dir: -1 | 1; vertical: boolean }> = {
	ArrowLeft: { dir: -1, vertical: false },
	ArrowRight: { dir: 1, vertical: false },
	ArrowUp: { dir: -1, vertical: true },
	ArrowDown: { dir: 1, vertical: true },
};

function handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
	if (view.composing) return false;
	const mod = event.metaKey || event.ctrlKey;
	const key = event.key.toLowerCase();
	if (mod && !event.altKey && key === "d" && !event.shiftKey) {
		return addNextOccurrence(view.state, view.dispatch);
	}
	if (mod && !event.altKey && key === "l" && event.shiftKey) {
		return selectAllOccurrences(view.state, view.dispatch);
	}
	if (!isMulti(view.state)) return false;
	if (event.key === "Escape")
		return collapseToPrimary(view.state, view.dispatch);
	if (event.key === "Backspace" && !mod && !event.altKey) {
		return deleteAtAllRanges(view.state, view.dispatch, -1);
	}
	if (event.key === "Delete" && !mod && !event.altKey) {
		return deleteAtAllRanges(view.state, view.dispatch, 1);
	}
	const arrow = ARROWS[event.key];
	if (arrow) {
		let move: Move = "char";
		if (arrow.vertical) {
			if (mod || event.altKey) return false;
			move = "vertical";
		} else if (event.metaKey) move = "line";
		else if (event.altKey) move = "word";
		else if (event.ctrlKey) return false;
		return moveAllRanges(view, arrow.dir, move, event.shiftKey);
	}
	return false;
}

function collapseIfMulti(view: EditorView) {
	if (multiSelectionKey.getState(view.state)) {
		view.dispatch(view.state.tr.setMeta(multiSelectionKey, null));
	}
}

export const MultiSelectionExtension = Extension.create({
	name: "multiSelection",
	// Ahead of input rules / markdown rollover / link handlers, so a
	// multi-range keystroke is handled once here and never reaches them.
	priority: 1000,

	addProseMirrorPlugins() {
		return [
			new Plugin<MultiSelectionState>({
				key: multiSelectionKey,
				state: {
					init: () => null,
					apply: (tr, previous) => {
						const meta = tr.getMeta(multiSelectionKey) as
							| MultiSelectionState
							| undefined;
						if (meta !== undefined) return meta;
						if (!previous) return null;
						const appended = tr.getMeta("appendedTransaction") !== undefined;
						if (!appended && (tr.selectionSet || tr.docChanged)) return null;
						if (!tr.docChanged) return previous;
						return {
							...previous,
							ranges: previous.ranges.map((range) => ({
								anchor: tr.mapping.map(range.anchor),
								head: tr.mapping.map(range.head),
							})),
						};
					},
				},
				props: {
					handleKeyDown,
					handleTextInput(view, _from, _to, text) {
						if (!isMulti(view.state)) return false;
						if (view.composing) {
							collapseIfMulti(view);
							return false;
						}
						return insertTextAtAllRanges(view.state, view.dispatch, text);
					},
					handleDOMEvents: {
						compositionstart(view) {
							collapseIfMulti(view);
							return false;
						},
					},
					decorations(state) {
						const session = multiSelectionKey.getState(state);
						if (!session || session.ranges.length < 2) return null;
						const size = state.doc.content.size;
						const decorations: Decoration[] = [];
						session.ranges.forEach((range, index) => {
							if (index === session.primary) return;
							const from = rangeFrom(range);
							const to = rangeTo(range);
							if (from < 0 || to > size) return;
							if (from < to) {
								decorations.push(
									Decoration.inline(from, to, {
										class: "pm-multi-selection",
									}),
								);
							}
							decorations.push(
								Decoration.widget(range.head, caretWidget, {
									key: "multi-caret",
									side: range.head === from ? -1 : 1,
								}),
							);
						});
						return DecorationSet.create(state.doc, decorations);
					},
				},
			}),
		];
	},
});

function caretWidget() {
	const caret = document.createElement("span");
	caret.className = "pm-multi-caret";
	caret.setAttribute("aria-hidden", "true");
	return caret;
}
