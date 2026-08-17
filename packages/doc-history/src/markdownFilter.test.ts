import { describe, expect, it } from "vitest";
import { isVersionableMarkdownPath } from "./markdownFilter.js";

describe("isVersionableMarkdownPath (R7)", () => {
	it("accepts .md, .markdown, and .mdown, case-insensitively", () => {
		expect(isVersionableMarkdownPath("notes/todo.md")).toBe(true);
		expect(isVersionableMarkdownPath("notes/todo.MD")).toBe(true);
		expect(isVersionableMarkdownPath("notes/todo.markdown")).toBe(true);
		expect(isVersionableMarkdownPath("notes/todo.mdown")).toBe(true);
	});

	it("rejects binary assets, HTML apps, and extensionless paths", () => {
		expect(isVersionableMarkdownPath("assets/photo.png")).toBe(false);
		expect(isVersionableMarkdownPath("assets/doc.pdf")).toBe(false);
		expect(isVersionableMarkdownPath("apps/tool.html")).toBe(false);
		expect(isVersionableMarkdownPath("README")).toBe(false);
	});
});
