import { describe, expect, it } from "vitest";
import { lastFolderName } from "./FolderChip";

describe("lastFolderName", () => {
	it("keeps only the innermost folder", () => {
		expect(
			lastFolderName("command-bar-macos-paradee/.build/checkouts/x/src/sqlite"),
		).toBe("sqlite");
		expect(lastFolderName("briefs")).toBe("briefs");
		expect(lastFolderName("a\\b\\c")).toBe("c");
		expect(lastFolderName("a/b/")).toBe("b");
	});

	it("is empty for the workspace root", () => {
		expect(lastFolderName("—")).toBe("");
		expect(lastFolderName("")).toBe("");
	});
});
