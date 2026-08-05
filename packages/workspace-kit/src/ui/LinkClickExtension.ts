import type { LinkKind } from "../engine/index.js";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

type LinkPayload = {
	href: string;
	kind: LinkKind;
	target: string | null;
};

function findLinkAtEvent(
	view: EditorView,
	event: MouseEvent,
): LinkPayload | null {
	const state = view.state;
	const posData = view.posAtCoords({ left: event.clientX, top: event.clientY });
	if (!posData) return null;
	const $pos = state.doc.resolve(posData.pos);
	for (const mark of $pos.marks()) {
		if (mark.type.name === "link" && typeof mark.attrs.href === "string") {
			return {
				href: mark.attrs.href,
				kind:
					mark.attrs.kind === "wiki" || mark.attrs.kind === "notionMention"
						? mark.attrs.kind
						: "url",
				target:
					typeof mark.attrs.target === "string" ? mark.attrs.target : null,
			};
		}
	}
	return null;
}

const MOD_CLASS = "mod-held";

function setModHeld(el: HTMLElement, held: boolean) {
	el.classList.toggle(MOD_CLASS, held);
}

export const LinkClickExtension = Extension.create<{
	onOpenExternalLink?: (href: string) => void | Promise<void>;
	onOpenWikiLink?: (target: string) => void | Promise<void>;
	onOpenNotionMentionLink?: (href: string) => void | Promise<void>;
}>({
	name: "linkClick",
	addProseMirrorPlugins() {
		const root = this.editor.view.dom;

		const onKey = (e: KeyboardEvent) =>
			setModHeld(root, e.metaKey || e.ctrlKey);
		const onBlur = () => setModHeld(root, false);

		window.addEventListener("keydown", onKey);
		window.addEventListener("keyup", onKey);
		window.addEventListener("blur", onBlur);

		return [
			new Plugin({
				props: {
					handleDOMEvents: {
						mousedown: (view, event) => {
							if (!event.metaKey && !event.ctrlKey) return false;
							const link = findLinkAtEvent(view, event);
							if (!link) return false;
							event.preventDefault();
							if (link.kind === "wiki") {
								void this.options.onOpenWikiLink?.(link.target ?? link.href);
								return true;
							}
							if (link.kind === "notionMention") {
								void this.options.onOpenNotionMentionLink?.(link.href);
								return true;
							}
							void this.options.onOpenExternalLink?.(link.href);
							return true;
						},
					},
				},
				destroy() {
					window.removeEventListener("keydown", onKey);
					window.removeEventListener("keyup", onKey);
					window.removeEventListener("blur", onBlur);
					setModHeld(root, false);
				},
			}),
		];
	},
});
