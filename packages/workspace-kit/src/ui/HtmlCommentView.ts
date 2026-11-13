import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import type { NodeView } from "@tiptap/pm/view";
import { isSubmitShortcut } from "../comments/submitShortcut.js";
import {
	HtmlCommentBlockExtension,
	HtmlCommentExtension,
	htmlCommentText,
	validateHtmlCommentText,
	withHtmlCommentText,
} from "../engine/HtmlComment.js";

const OPEN_EVENT = "mdly-html-comment-open";

/**
 * Collapsed marker for an HTML comment: a small dot in the text flow, the
 * full note in its tooltip/aria-label, and a click/Enter popover to read or
 * edit it. Plain DOM (not a React node view) so the inline marker adds no
 * wrapper elements that could disturb line height.
 */
function createHtmlCommentView(
	node: PMNode,
	editor: Editor,
	getPos: () => number | undefined,
	inline: boolean,
): NodeView {
	let current = node;
	const dom = document.createElement(inline ? "span" : "div");
	dom.className = inline ? "pm-html-comment" : "pm-html-comment-block";
	dom.contentEditable = "false";
	const marker = document.createElement("span");
	marker.className = "pm-html-comment-marker";
	marker.setAttribute("data-html-comment-marker", "");
	marker.setAttribute("role", "button");
	marker.tabIndex = 0;
	dom.append(marker);

	const label = () => {
		const text = htmlCommentText(current.attrs.raw as string);
		marker.title = text;
		marker.setAttribute("aria-label", `Note: ${text}`);
	};
	label();

	let popover: HTMLElement | null = null;
	const onOutside = (event: MouseEvent) => {
		const target = event.target as globalThis.Node | null;
		if (popover?.contains(target) || marker.contains(target)) return;
		close();
	};
	const close = () => {
		popover?.remove();
		popover = null;
		document.removeEventListener("mousedown", onOutside, true);
	};

	const save = (text: string, error: HTMLElement): boolean => {
		const problem = validateHtmlCommentText(text);
		if (problem) {
			error.textContent = problem;
			error.hidden = false;
			return false;
		}
		const pos = getPos();
		if (typeof pos !== "number") return false;
		const raw = withHtmlCommentText(current.attrs.raw as string, text);
		if (raw !== current.attrs.raw) {
			editor.view.dispatch(
				editor.state.tr.setNodeMarkup(pos, undefined, {
					...current.attrs,
					raw,
				}),
			);
		}
		close();
		editor.view.focus();
		return true;
	};

	const button = (text: string, data: string, primary = false) => {
		const el = document.createElement("button");
		el.type = "button";
		el.textContent = text;
		el.className = primary
			? "pm-html-comment-button pm-html-comment-button--primary"
			: "pm-html-comment-button";
		el.setAttribute(data, "");
		return el;
	};

	const renderRead = (box: HTMLElement) => {
		box.replaceChildren();
		const body = document.createElement("p");
		body.className = "pm-html-comment-text";
		body.textContent = htmlCommentText(current.attrs.raw as string);
		const actions = document.createElement("div");
		actions.className = "pm-html-comment-actions";
		const edit = button("Edit", "data-html-comment-edit");
		edit.addEventListener("click", () => renderEdit(box));
		actions.append(edit);
		box.append(body, actions);
	};

	const renderEdit = (box: HTMLElement) => {
		box.replaceChildren();
		const textarea = document.createElement("textarea");
		textarea.className = "pm-html-comment-input";
		textarea.value = htmlCommentText(current.attrs.raw as string);
		textarea.setAttribute("aria-label", "Edit note");
		const error = document.createElement("p");
		error.className = "pm-html-comment-error";
		error.setAttribute("data-html-comment-error", "");
		error.setAttribute("role", "alert");
		error.hidden = true;
		const actions = document.createElement("div");
		actions.className = "pm-html-comment-actions";
		const saveButton = button("Save", "data-html-comment-save", true);
		saveButton.title = "Save (⌘↩)";
		saveButton.setAttribute("aria-keyshortcuts", "Meta+Enter");
		const cancel = button("Cancel", "data-html-comment-cancel");
		saveButton.addEventListener("click", () => save(textarea.value, error));
		cancel.addEventListener("click", () => renderRead(box));
		textarea.addEventListener("input", () => {
			error.hidden = true;
		});
		textarea.addEventListener("keydown", (event) => {
			if (!isSubmitShortcut(event)) return;
			event.preventDefault();
			event.stopPropagation();
			save(textarea.value, error);
		});
		actions.append(saveButton, cancel);
		box.append(textarea, error, actions);
		textarea.focus();
	};

	const open = () => {
		if (popover) return;
		const box = document.createElement("div");
		box.className = "pm-html-comment-popover";
		box.setAttribute("data-html-comment-popover", "");
		box.setAttribute("role", "dialog");
		box.setAttribute("aria-label", "HTML comment");
		box.addEventListener("keydown", (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			close();
			marker.focus();
		});
		const rect = marker.getBoundingClientRect();
		box.style.insetBlockStart = `${rect.bottom + window.scrollY + 6}px`;
		box.style.insetInlineStart = `${Math.max(8, rect.left + window.scrollX - 8)}px`;
		renderRead(box);
		document.body.append(box);
		popover = box;
		document.addEventListener("mousedown", onOutside, true);
		box.querySelector<HTMLElement>("button")?.focus();
	};

	marker.addEventListener("mousedown", (event) => event.preventDefault());
	marker.addEventListener("click", (event) => {
		event.preventDefault();
		popover ? close() : open();
	});
	marker.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		event.stopPropagation();
		open();
	});
	dom.addEventListener(OPEN_EVENT, open);

	return {
		dom,
		update(next) {
			if (next.type !== current.type) return false;
			current = next;
			label();
			return true;
		},
		selectNode() {
			dom.classList.add("ProseMirror-selectednode");
		},
		deselectNode() {
			dom.classList.remove("ProseMirror-selectednode");
		},
		stopEvent(event) {
			return dom.contains(event.target as globalThis.Node) &&
				event.target !== dom
				? event.type !== "dragstart"
				: false;
		},
		ignoreMutation: () => true,
		destroy: close,
	};
}

/** Enter on a selected comment node opens its popover instead of splitting. */
function openSelectedComment(editor: Editor): boolean {
	const { selection } = editor.state;
	if (
		!(selection instanceof NodeSelection) ||
		!selection.node.type.name.startsWith("htmlComment")
	) {
		return false;
	}
	editor.view.nodeDOM(selection.from)?.dispatchEvent(new Event(OPEN_EVENT));
	return true;
}

/**
 * Backspace/Delete beside an inline comment removes the whole comment in one
 * undoable step (explicit, rather than relying on contenteditable's native
 * deletion around a non-editable span).
 */
function deleteAdjacentComment(editor: Editor, forward: boolean): boolean {
	const { selection } = editor.state;
	if (!selection.empty) return false;
	const $pos = selection.$from;
	const neighbour = forward ? $pos.nodeAfter : $pos.nodeBefore;
	if (neighbour?.type.name !== "htmlComment") return false;
	const from = forward ? $pos.pos : $pos.pos - neighbour.nodeSize;
	editor.view.dispatch(
		editor.state.tr.delete(from, from + neighbour.nodeSize).scrollIntoView(),
	);
	return true;
}

export const HtmlCommentViewExtension = HtmlCommentExtension.extend({
	addNodeView() {
		return ({ node, editor, getPos }) =>
			createHtmlCommentView(node, editor, getPos, true);
	},
	addKeyboardShortcuts() {
		return {
			Enter: () => openSelectedComment(this.editor),
			Backspace: () => deleteAdjacentComment(this.editor, false),
			Delete: () => deleteAdjacentComment(this.editor, true),
		};
	},
});

export const HtmlCommentBlockViewExtension = HtmlCommentBlockExtension.extend({
	addNodeView() {
		return ({ node, editor, getPos }) =>
			createHtmlCommentView(node, editor, getPos, false);
	},
	addKeyboardShortcuts() {
		return { Enter: () => openSelectedComment(this.editor) };
	},
});

export const htmlCommentViewExtensions = [
	HtmlCommentViewExtension,
	HtmlCommentBlockViewExtension,
];
