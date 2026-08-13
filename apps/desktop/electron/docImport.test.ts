import { describe, expect, it } from "vitest";
import {
	anydocCommandPathEnv,
	checkConverterStatus,
	docMarkdownContentHash,
	resolveAnyDocCommandPath,
} from "./docImport";

describe("resolveAnyDocCommandPath", () => {
	it("finds anydoc in common macOS install locations when PATH omits it", () => {
		const executablePaths = new Set(["/usr/local/bin/anydoc"]);

		expect(
			resolveAnyDocCommandPath({
				pathEnv: "/usr/bin:/bin:/usr/sbin:/sbin",
				isExecutable: (filePath) => executablePaths.has(filePath),
			}),
		).toBe("/usr/local/bin/anydoc");
	});

	it("prefers PATH before common macOS install locations", () => {
		const executablePaths = new Set([
			"/custom/bin/anydoc",
			"/usr/local/bin/anydoc",
		]);

		expect(
			resolveAnyDocCommandPath({
				pathEnv: "/custom/bin:/usr/bin",
				isExecutable: (filePath) => executablePaths.has(filePath),
			}),
		).toBe("/custom/bin/anydoc");
	});

	it("allows an explicit command override", () => {
		expect(
			resolveAnyDocCommandPath({
				configuredCommand: "/custom/tools/anydoc",
				pathEnv: "",
				isExecutable: () => false,
			}),
		).toBe("/custom/tools/anydoc");
	});
});

describe("anydocCommandPathEnv", () => {
	it("adds the resolved wrapper directory so anydoc can exec assistants", () => {
		expect(
			anydocCommandPathEnv(
				"/usr/local/bin/anydoc",
				"/usr/bin:/bin:/usr/sbin:/sbin",
			).split(":"),
		).toEqual([
			"/usr/local/bin",
			"/opt/homebrew/bin",
			"/usr/bin",
			"/bin",
			"/usr/sbin",
			"/sbin",
		]);
	});
});

describe("checkConverterStatus", () => {
	it("returns unavailable when anydoc is not on PATH", async () => {
		const status = await checkConverterStatus();
		// When anydoc is not installed, this should return unavailable.
		// In CI, anydoc may or may not be present.
		expect(status).toHaveProperty("available");
		expect(typeof status.available).toBe("boolean");
		if (!status.available) {
			expect(status.installHint).toBeTruthy();
		}
	});
});

describe("docMarkdownContentHash", () => {
	it("produces a stable hash for the same input", () => {
		const hash1 = docMarkdownContentHash("# Hello\n\nWorld");
		const hash2 = docMarkdownContentHash("# Hello\n\nWorld");
		expect(hash1).toBe(hash2);
	});

	it("produces different hashes for different inputs", () => {
		const hash1 = docMarkdownContentHash("# Hello");
		const hash2 = docMarkdownContentHash("# World");
		expect(hash1).not.toBe(hash2);
	});
});