import { describe, expect, it } from "vitest";
import {
	CompiledTextPattern,
	cleanEntries,
	isPatternEntry,
	matchesEntries,
	matchesEntry,
	splitEntries,
} from "./textPattern";

// Ported from IndieLibKit TextPatternTests (FastTab's rule).
describe("textPattern", () => {
	it("plain, wildcard and regex", () => {
		expect(matchesEntry("FastTab-reader", "fasttab")).toBe(true);
		expect(matchesEntry("pog-full-categories", "*full*")).toBe(true);
		expect(matchesEntry("pog-full-categories", "/^pog-/")).toBe(true);
		expect(
			matchesEntry("https://github.com/a/b/issues/3", "github.com/*/issues"),
		).toBe(true);
		expect(matchesEntry("my-pog", "/^pog-/")).toBe(false);
		expect(matchesEntry("parklet", "fasttab")).toBe(false);
		expect(matchesEntries("anything", [])).toBe(false);
	});

	it("is case-insensitive everywhere", () => {
		expect(matchesEntry("GitHub", "github")).toBe(true);
		expect(matchesEntry("GitHub", "*HUB")).toBe(true);
		expect(matchesEntry("github", "/^GIT/")).toBe(true);
	});

	it("wildcard escapes regex characters", () => {
		expect(matchesEntry("a.b(c)", "a.b(*")).toBe(true);
		expect(matchesEntry("axb(c)", "a.b(*")).toBe(false);
	});

	it("a broken regex matches nothing and never throws", () => {
		expect(matchesEntry("/[/", "/[/")).toBe(false);
	});

	it("injection-looking text is just text", () => {
		const entry = "$(echo INJECTED)";
		expect(matchesEntry("x $(echo INJECTED) y", entry)).toBe(true);
		expect(matchesEntry("INJECTED", entry)).toBe(false);
	});

	it("matches any of several texts", () => {
		const folder = "/Users/me/01_Project/command-bar-macos";
		const c = new CompiledTextPattern(["*command-bar*"]);
		expect(c.matchesAnyOf(["session-1", folder])).toBe(true);
		expect(
			new CompiledTextPattern(["/01_Project\\/command/"]).matchesAnyOf([
				"session-1",
				folder,
			]),
		).toBe(true);
		expect(
			new CompiledTextPattern(["*command*"]).matchesAnyOf(["session-1", null]),
		).toBe(false);
	});

	it("clean drops junk and keeps regex case", () => {
		expect(
			cleanEntries([" FastTab ", "", "**", "/[/", "fasttab", "/^Pog/"]),
		).toEqual(["fasttab", "/^Pog/"]);
		expect(isPatternEntry("*x") && isPatternEntry("/x/")).toBe(true);
		expect(isPatternEntry("x")).toBe(false);
	});

	it("compiled matches like uncompiled", () => {
		const entries = [
			"fasttab",
			"*full*",
			"/^pog-/",
			"github.com/*/issues",
			"/(unclosed/",
		];
		const compiled = new CompiledTextPattern(entries);
		for (const text of [
			"FastTab-reader",
			"pog-full-categories",
			"my-pog",
			"https://github.com/a/b/issues/3",
			"parklet",
			"(unclosed",
			"$(echo INJECTED)",
		]) {
			expect(compiled.matches(text)).toBe(matchesEntries(text, entries));
		}
		expect(compiled.matches("(unclosed")).toBe(false);
		expect(compiled.matchesAnyOf([null, "x", "FASTTAB"])).toBe(true);
		expect(compiled.matchesAnyOf([null])).toBe(false);
	});

	it("empty matches nothing", () => {
		expect(new CompiledTextPattern([]).isEmpty).toBe(true);
		expect(new CompiledTextPattern([]).matches("anything")).toBe(false);
	});

	it("splits a comma list, OR-ed; a lone regex keeps its commas", () => {
		expect(splitEntries(" memory/*, *spec*.md ,, /x/ ")).toEqual([
			"memory/*",
			"*spec*.md",
			"/x/",
		]);
		expect(splitEntries("/a{1,3}/")).toEqual(["/a{1,3}/"]);
		const c = CompiledTextPattern.parse("memory/*, *spec*.md");
		expect(c.matches("memory/a/b.md")).toBe(true);
		expect(c.matches("docs/API-Spec-v2.md")).toBe(true);
		expect(c.matches("docs/readme.md")).toBe(false);
	});
});
