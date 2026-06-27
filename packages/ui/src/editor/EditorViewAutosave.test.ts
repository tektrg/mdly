import { describe, expect, it } from "vitest";
import { hasRecentEditorUserIntent } from "./EditorView";

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
