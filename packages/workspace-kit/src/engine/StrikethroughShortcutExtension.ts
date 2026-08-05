import { Extension } from "@tiptap/core";

export const StrikethroughShortcutExtension = Extension.create({
	name: "strikethroughShortcut",

	addKeyboardShortcuts() {
		return {
			"Mod-Shift-x": () => this.editor.commands.toggleMark("strike"),
		};
	},
});
