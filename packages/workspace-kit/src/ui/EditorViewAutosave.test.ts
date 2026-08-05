import { describe, expect, it } from "vitest";
import {
	hasRecentEditorUserIntent,
	mergeEditorFontAttributeStyle,
} from "./EditorView";

describe("EditorView autosave intent guard", () => {
	it("rejects editor updates that occur without recent user input", () => {
		expect(hasRecentEditorUserIntent(Number.NEGATIVE_INFINITY, 10_000)).toBe(
			false,
		);
		expect(hasRecentEditorUserIntent(8_999, 10_000)).toBe(false);
	});

	it("accepts editor updates that follow recent user input", () => {
		expect(hasRecentEditorUserIntent(9_001, 10_000)).toBe(true);
		expect(hasRecentEditorUserIntent(10_000, 10_000)).toBe(true);
	});
});

describe("EditorView font attribute style", () => {
	it("adds the editor font variable to empty styles", () => {
		expect(mergeEditorFontAttributeStyle()).toBe(
			"font-family: var(--editor-font-family);",
		);
	});

	it("preserves existing styles while adding the editor font", () => {
		expect(mergeEditorFontAttributeStyle("tab-size: 4")).toBe(
			"tab-size: 4; font-family: var(--editor-font-family);",
		);
	});

	it("does not override an explicit editorProps font family", () => {
		expect(mergeEditorFontAttributeStyle("font-family: serif;")).toBe(
			"font-family: serif;",
		);
	});
});
