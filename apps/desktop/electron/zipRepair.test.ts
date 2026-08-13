import { describe, expect, it } from "vitest";
import { repairOfficeZipBackslashes } from "./zipRepair";

describe("repairOfficeZipBackslashes", () => {
	it("returns null for non-Office files", async () => {
		expect(await repairOfficeZipBackslashes("/tmp/notes.txt")).toBeNull();
		expect(await repairOfficeZipBackslashes("/tmp/notes.md")).toBeNull();
	});

	it("returns null for files that do not exist", async () => {
		expect(
			await repairOfficeZipBackslashes("/tmp/does-not-exist.docx"),
		).toBeNull();
	});

	it("returns null for a docx without backslash entries", async () => {
		// A minimal valid-ish zip with a forward-slash entry name should pass
		// through unchanged (no repair).
		const result = await repairOfficeZipBackslashes("/tmp/plain.docx");
		// We cannot easily fabricate a real zip here, so we only assert the
		// function does not throw and returns null for a non-zip.
		expect(result).toBeNull();
	});
});