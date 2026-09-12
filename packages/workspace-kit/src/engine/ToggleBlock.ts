import { mergeAttributes, Node } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

/**
 * Notion-style collapsible "toggle" block, backed by `<details><summary>`.
 *
 * The `open` attribute only seeds the NodeView's initial expand/collapse
 * state (see ToggleBlockView); expand/collapse afterwards is local UI state,
 * never written back to attrs or serialized, so clicking a toggle never
 * dirties the document. See markdownToProsemirror / prosemirrorToMarkdown
 * for the round-trip mapping.
 */
export const ToggleExtension = Node.create({
	name: "toggle",
	group: "block",
	content: "toggleSummary block+",
	defining: true,

	addAttributes() {
		return {
			open: {
				default: false,
				parseHTML: (element) => element.hasAttribute("open"),
				renderHTML: (attributes) => (attributes.open ? { open: "" } : {}),
			},
		};
	},

	parseHTML() {
		return [{ tag: "details" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["details", mergeAttributes(HTMLAttributes), 0];
	},
});

export const ToggleSummaryExtension = Node.create({
	name: "toggleSummary",
	content: "inline*",
	defining: true,
	isolating: true,
	// Above StarterKit (100) AND the v3 core nodes/keymap (1000): our Enter
	// must win over baseKeymap splitBlock inside the summary. Same precedent
	// as Heading/ListToggle (2000).
	priority: 2000,

	parseHTML() {
		return [{ tag: "summary" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["summary", mergeAttributes(HTMLAttributes), 0];
	},

	addKeyboardShortcuts() {
		return {
			// The summary is a single-line title (`inline*`): splitting it would
			// produce a second summary, which the `toggleSummary block+`
			// content model forbids. Enter therefore means "done with the
			// title" and moves the cursor into the first body block instead,
			// matching the slash-menu flow (cursor starts in the fresh summary,
			// one Enter lands in the body ready to type).
			Enter: ({ editor }) => {
				const { $from } = editor.state.selection;
				if ($from.parent.type.name !== "toggleSummary") return false;
				for (let depth = $from.depth; depth > 0; depth -= 1) {
					if ($from.node(depth).type.name !== "toggle") continue;
					const bodyPos =
						$from.before(depth) + 1 + $from.node(depth).child(0).nodeSize;
					editor.view.dispatch(
						editor.state.tr.setSelection(
							TextSelection.near(editor.state.doc.resolve(bodyPos)),
						),
					);
					return true;
				}
				return false;
			},
		};
	},
});

export const toggleBlockExtensions = [ToggleExtension, ToggleSummaryExtension];
