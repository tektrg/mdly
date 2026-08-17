import { describe, expect, it } from "vitest";
import { isHiddenSidebarFolderName } from "./filePath";

describe("isHiddenSidebarFolderName", () => {
	it("matches app-owned directories excluded from the sidebar", () => {
		expect(isHiddenSidebarFolderName(".hubble")).toBe(true);
		expect(isHiddenSidebarFolderName(".mdly")).toBe(true);
		expect(isHiddenSidebarFolderName("note.assets")).toBe(true);
		expect(isHiddenSidebarFolderName("note.assets.backup")).toBe(false);
		expect(isHiddenSidebarFolderName("assets")).toBe(false);
	});
});
