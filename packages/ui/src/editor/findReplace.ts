import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

export type FindOptions = {
	caseSensitive: boolean;
};

export type TextMatch = {
	from: number;
	to: number;
	text: string;
};

export type StringMatch = {
	from: number;
	to: number;
	text: string;
};

export function findStringMatches(
	text: string,
	query: string,
	options: FindOptions,
): StringMatch[] {
	if (query.length === 0) return [];
	const haystack = options.caseSensitive ? text : text.toLocaleLowerCase();
	const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
	const matches: StringMatch[] = [];
	let index = 0;
	while (index <= haystack.length - needle.length) {
		const found = haystack.indexOf(needle, index);
		if (found === -1) break;
		matches.push({
			from: found,
			to: found + query.length,
			text: text.slice(found, found + query.length),
		});
		index = found + Math.max(query.length, 1);
	}
	return matches;
}

export function findDocumentTextMatches(
	doc: ProseMirrorNode,
	query: string,
	options: FindOptions,
): TextMatch[] {
	if (query.length === 0) return [];
	const matches: TextMatch[] = [];
	doc.descendants((node, pos) => {
		if (!node.isText || !node.text) return;
		for (const match of findStringMatches(node.text, query, options)) {
			matches.push({
				from: pos + match.from,
				to: pos + match.to,
				text: match.text,
			});
		}
	});
	return matches.sort((a, b) => a.from - b.from || a.to - b.to);
}

export function matchIndexAfterPosition(
	matches: TextMatch[],
	position: number,
) {
	const nextIndex = matches.findIndex((match) => match.to > position);
	return nextIndex === -1 ? 0 : nextIndex;
}

export function replaceEditorMatch(
	editor: Editor,
	match: TextMatch,
	replacement: string,
) {
	editor
		.chain()
		.focus()
		.setTextSelection({ from: match.from, to: match.to })
		.insertContent(replacement)
		.run();
}

export function replaceAllEditorMatches(
	editor: Editor,
	matches: TextMatch[],
	replacement: string,
) {
	if (matches.length === 0) return;
	let tr = editor.state.tr;
	for (const match of [...matches].reverse()) {
		tr = tr.insertText(replacement, match.from, match.to);
	}
	editor.view.dispatch(tr.scrollIntoView());
}

export function selectEditorMatch(editor: Editor, match: TextMatch) {
	const selection = TextSelection.create(
		editor.state.doc,
		match.from,
		match.to,
	);
	editor.view.dispatch(
		editor.state.tr.setSelection(selection).scrollIntoView(),
	);
	scrollEditorMatchIntoView(editor, match);
}

function scrollEditorMatchIntoView(editor: Editor, match: TextMatch) {
	const scrollContainer = findScrollContainer(editor.view.dom);
	if (!scrollContainer) return;

	const scroll = () => {
		let start: ReturnType<typeof editor.view.coordsAtPos>;
		let end: ReturnType<typeof editor.view.coordsAtPos>;
		try {
			start = editor.view.coordsAtPos(match.from);
			end = editor.view.coordsAtPos(match.to);
		} catch {
			return;
		}
		const matchTop = Math.min(start.top, end.top);
		const matchBottom = Math.max(start.bottom, end.bottom);
		const containerRect = scrollContainer.getBoundingClientRect();
		const margin = 48;
		const visibleTop = containerRect.top + margin;
		const visibleBottom = containerRect.bottom - margin;

		if (matchTop >= visibleTop && matchBottom <= visibleBottom) return;

		const matchCenter = (matchTop + matchBottom) / 2;
		const containerCenter = (containerRect.top + containerRect.bottom) / 2;
		const scrollTopDelta = matchCenter - containerCenter;
		if (typeof scrollContainer.scrollBy === "function") {
			scrollContainer.scrollBy({
				top: scrollTopDelta,
				behavior: prefersReducedMotion() ? "auto" : "smooth",
			});
			return;
		}
		scrollContainer.scrollTop += scrollTopDelta;
	};

	if (typeof requestAnimationFrame === "function") {
		requestAnimationFrame(scroll);
		return;
	}
	scroll();
}

function findScrollContainer(element: HTMLElement) {
	let current: HTMLElement | null = element.parentElement;
	while (current) {
		const style = getComputedStyle(current);
		const overflowY = style.overflowY || style.overflow;
		if (/(auto|scroll|overlay)/.test(overflowY)) return current;
		current = current.parentElement;
	}
	return null;
}

function prefersReducedMotion() {
	return (
		typeof matchMedia === "function" &&
		matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

export function replaceStringMatch(
	text: string,
	match: StringMatch,
	replacement: string,
) {
	return `${text.slice(0, match.from)}${replacement}${text.slice(match.to)}`;
}

export function replaceAllStringMatches(
	text: string,
	matches: StringMatch[],
	replacement: string,
) {
	let next = text;
	for (const match of [...matches].reverse()) {
		next = replaceStringMatch(next, match, replacement);
	}
	return next;
}
