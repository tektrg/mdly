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
import { placeNotePopover, type Rect } from "./htmlCommentPopoverPosition.js";

const OPEN_EVENT = "mdly-html-comment-open";
const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 200;

/** Only one note popover at a time, across every marker in every editor. */
let closeActive: (() => void) | null = null;

/** Visible editor area (pane ∩ viewport) the popover must stay inside. */
function visibleBounds(from: Element): Rect {
	const host = from.closest("[data-hubble-editor]") ?? from;
	const r = host.getBoundingClientRect();
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const box = {
		left: Math.max(0, r.left),
		top: Math.max(0, r.top),
		right: Math.min(vw, r.right),
		bottom: Math.min(vh, r.bottom),
	};
	// Degenerate (unlaid-out / off-screen host): fall back to the viewport.
	return box.right - box.left < 50 || box.bottom - box.top < 50
		? { left: 0, top: 0, right: vw, bottom: vh }
		: box;
}

/**
 * Collapsed marker for an HTML comment: a small dot in the text flow, the
 * full note in its aria-label, and a popover that opens on hover/focus
 * (transient) or click/Enter (pinned) to read or edit it. Plain DOM (not a React node view) so the inline marker adds no
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
		marker.setAttribute("aria-label", `Note: ${text}`);
	};
	label();

	let popover: HTMLElement | null = null;
	let pinned = false;
	/** Returning focus after Esc must not reopen via the focus handler. */
	let refocusing = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const clearTimer = () => {
		clearTimeout(timer);
		timer = undefined;
	};
	const onOutside = (event: MouseEvent) => {
		const target = event.target as globalThis.Node | null;
		if (popover?.contains(target) || marker.contains(target)) return;
		close();
	};
	const close = () => {
		clearTimer();
		popover?.remove();
		popover = null;
		pinned = false;
		if (closeActive === close) closeActive = null;
		document.removeEventListener("mousedown", onOutside, true);
	};
	const scheduleClose = () => {
		if (pinned || !popover) return;
		clearTimer();
		timer = setTimeout(close, HOVER_CLOSE_MS);
	};
	const pin = () => {
		clearTimer();
		pinned = true;
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
		edit.addEventListener("click", () => {
			pin();
			renderEdit(box);
		});
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
		cancel.addEventListener("click", () => {
			renderRead(box);
			place(box);
		});
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
		place(box);
		textarea.focus();
	};

	const place = (box: HTMLElement) => {
		const p = placeNotePopover(
			marker.getBoundingClientRect(),
			{ width: box.offsetWidth, height: box.offsetHeight },
			visibleBounds(marker),
		);
		box.dataset.placement = p.placement;
		box.style.insetBlockStart = `${p.top + window.scrollY}px`;
		box.style.insetInlineStart = `${p.left + window.scrollX}px`;
	};

	/** `pinnedOpen`: click/Enter (focus moves in, stays until dismissed). */
	const open = (pinnedOpen: boolean) => {
		clearTimer();
		if (pinnedOpen) pinned = true;
		if (popover) {
			if (pinnedOpen) popover.querySelector<HTMLElement>("button")?.focus();
			return;
		}
		closeActive?.();
		closeActive = close;
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
			refocusing = true;
			marker.focus({ preventScroll: true });
			refocusing = false;
		});
		box.addEventListener("mouseenter", clearTimer);
		box.addEventListener("mouseleave", scheduleClose);
		box.addEventListener("focusin", clearTimer);
		box.addEventListener("focusout", (event) => {
			const next = event.relatedTarget as globalThis.Node | null;
			if (!box.contains(next) && next !== marker) scheduleClose();
		});
		renderRead(box);
		document.body.append(box);
		popover = box;
		place(box);
		document.addEventListener("mousedown", onOutside, true);
		if (pinnedOpen) box.querySelector<HTMLElement>("button")?.focus();
	};

	marker.addEventListener("mousedown", (event) => event.preventDefault());
	marker.addEventListener("click", (event) => {
		event.preventDefault();
		if (popover && pinned) close();
		else open(true);
	});
	marker.addEventListener("mouseenter", () => {
		if (popover) {
			clearTimer();
			return;
		}
		clearTimer();
		timer = setTimeout(() => open(false), HOVER_OPEN_MS);
	});
	marker.addEventListener("mouseleave", () => {
		if (popover) scheduleClose();
		else clearTimer();
	});
	// Mouse clicks never focus the marker (mousedown is prevented), so focus
	// here means keyboard/AT navigation.
	marker.addEventListener("focus", () => {
		if (!refocusing) open(false);
	});
	marker.addEventListener("blur", (event) => {
		if (!popover?.contains(event.relatedTarget as globalThis.Node | null)) {
			scheduleClose();
		}
	});
	marker.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && popover) {
			event.preventDefault();
			event.stopPropagation();
			close();
			return;
		}
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		event.stopPropagation();
		open(true);
	});
	dom.addEventListener(OPEN_EVENT, () => open(true));

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
