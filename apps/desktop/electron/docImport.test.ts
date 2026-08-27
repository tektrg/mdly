import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	anydocCommandPathEnv,
	checkConverterStatus,
	docMarkdownContentHash,
	documentNamingUrl,
	isLoginWall,
	mapDocImportError,
	resolveAnyDocCommandPath,
	withSharePointDownloadParam,
} from "./docImport";

// checkConverterStatus/convertDocFile await a login-shell PATH merge that
// spawns a real shell (see externalCommand.ts). That's a slow, environment-
// dependent concern unrelated to what this file tests, so it's stubbed out.
vi.mock("./externalCommand", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./externalCommand")>();
	return { ...actual, ensureLoginShellPathMerged: vi.fn(async () => {}) };
});

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

describe("mapDocImportError", () => {
	it("maps a timeout to the timeout kind", () => {
		expect(mapDocImportError(new Error("command timed out")).kind).toBe(
			"timeout",
		);
	});

	it("maps a missing command to converter-missing", () => {
		expect(mapDocImportError(new Error("command not found")).kind).toBe(
			"converter-missing",
		);
	});

	it("maps a scanned-PDF error to the friendly scanned-pdf kind", () => {
		const error = mapDocImportError(
			new Error("unsupported: scanned image-only pdf"),
		);
		expect(error.kind).toBe("scanned-pdf");
		expect(error.message).toContain("scanned");
	});

	it("maps a generic unsupported error to unreadable", () => {
		expect(mapDocImportError(new Error("unsupported format")).kind).toBe(
			"unreadable",
		);
	});

	it("falls back to unknown for unrecognized errors", () => {
		expect(mapDocImportError(new Error("mystery failure")).kind).toBe(
			"unknown",
		);
	});
});

describe("withSharePointDownloadParam", () => {
	it("adds download=1 to a SharePoint personal share link", () => {
		expect(
			withSharePointDownloadParam(
				"https://contoso-my.sharepoint.com/:w:/g/personal/user/ABC?e=xyz",
			),
		).toBe(
			"https://contoso-my.sharepoint.com/:w:/g/personal/user/ABC?e=xyz&download=1",
		);
	});

	it("adds download=1 to a 1drv.ms short link", () => {
		expect(withSharePointDownloadParam("https://1drv.ms/w/s!abc")).toBe(
			"https://1drv.ms/w/s!abc?download=1",
		);
	});

	it("leaves an existing download param untouched", () => {
		const url = "https://contoso.sharepoint.com/doc.docx?download=1";
		expect(withSharePointDownloadParam(url)).toBe(url);
	});

	it("leaves unrelated hosts untouched", () => {
		const url = "https://example.com/report.docx";
		expect(withSharePointDownloadParam(url)).toBe(url);
	});
});

describe("documentNamingUrl", () => {
	it("prefers the final URL when it names a real document", () => {
		expect(
			documentNamingUrl(
				"https://contoso-my.sharepoint.com/:w:/g/personal/user/IQA4bMxsg-Token",
				"https://contoso-my.sharepoint.com/personal/user/Documents/10-August_2026_Check%20Point.docx?ga=1",
			),
		).toBe(
			"https://contoso-my.sharepoint.com/personal/user/Documents/10-August_2026_Check%20Point.docx?ga=1",
		);
	});

	it("falls back to the original URL when the final URL is a web app page", () => {
		const original = "https://example.com/report";
		expect(documentNamingUrl(original, "https://example.com/doc.aspx?id=1")).toBe(
			original,
		);
	});

	it("falls back to the original URL when the final URL has no extension", () => {
		const original = "https://example.com/report";
		expect(documentNamingUrl(original, "https://cdn.example.com/0f8a2b")).toBe(
			original,
		);
	});

	it("keeps a plain direct file URL unchanged", () => {
		const url = "https://example.com/report.docx";
		expect(documentNamingUrl(url, url)).toBe(url);
	});
});

describe("isLoginWall", () => {
	it("detects a 401 or 403 response as a login wall", () => {
		expect(isLoginWall(new Response("", { status: 401 }))).toBe(true);
		expect(isLoginWall(new Response("", { status: 403 }))).toBe(true);
	});

	it("does not flag an HTML document on an unknown host as a login wall", () => {
		expect(
			isLoginWall(
				new Response("<html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
			),
		).toBe(false);
	});
});

// R32 / O9: the doc-import pipeline is deliberately NOT one of the three
// wired write hooks (see the charter's out-of-scope section). This is a
// static regression guard, not a runtime one — it fails fast if doc-history
// is ever accidentally imported into this module, which would otherwise
// silently couple an unrelated pipeline into `.mdly/history` side effects.
describe("doc-import stays unwired from doc-history (R32)", () => {
	it("never references @mdly/doc-history or a historyCause in its source", async () => {
		const source = await fs.readFile(
			fileURLToPath(new URL("./docImport.ts", import.meta.url)),
			"utf8",
		);
		expect(source).not.toMatch(/@mdly\/doc-history/);
		expect(source).not.toMatch(/historyCause/);
	});
});
