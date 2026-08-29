import { describe, it, expect } from "vitest";
import { resolveAnchor } from "../src/anchor.js";
import type { TextAnchor } from "../src/types.js";

const identity = (text: string) => text;

function anchorFor(
	flattenedText: string,
	quote: string,
	extra: Partial<TextAnchor> = {},
): TextAnchor {
	const from = flattenedText.indexOf(quote);
	if (from === -1) throw new Error(`fixture bug: "${quote}" not found`);
	return { from, to: from + quote.length, quote, mode: "revision", ...extra };
}

describe("resolveAnchor", () => {
	describe("R11 — identical text replays to the exact recorded range", () => {
		it("maps to itself when nothing changed", async () => {
			const text = "alpha\nbeta\nTARGET line here\ndelta\n";
			const recorded = anchorFor(text, "TARGET line here", { revisionId: "rev1" });

			const result = await resolveAnchor(
				recorded,
				text,
				async () => text,
				identity,
			);

			expect(result.status).toBe("anchored");
			expect(result.method).toBe("revision-replay");
			expect(result.range).toEqual({ from: recorded.from, to: recorded.to });
		});
	});

	describe("R11 — formatting/front-matter-only edits keep the highlight in place", () => {
		it("keeps the highlight exactly where it was when only markup changed", async () => {
			// The recorded revision's raw body had bold markup; once flattened
			// (markup stripped) it renders identically to the current draft.
			const revisionBody = "alpha\nbeta\n**TARGET line here**\ndelta\n";
			const flattenedRevision = "alpha\nbeta\nTARGET line here\ndelta\n";
			const current = "alpha\nbeta\nTARGET line here\ndelta\n";
			const recorded = anchorFor(flattenedRevision, "TARGET line here", {
				revisionId: "rev1",
			});

			const result = await resolveAnchor(
				recorded,
				current,
				async () => revisionBody,
				() => flattenedRevision,
			);

			expect(result.status).toBe("anchored");
			expect(result.range).toEqual({ from: recorded.from, to: recorded.to });
		});
	});

	describe("R11 — an edit above the anchor moves the highlight to the surviving text", () => {
		it("shifts the range forward when a line is inserted before it", async () => {
			const oldText = "alpha\nbeta\nTARGET line here\ndelta\n";
			const newText = "alpha\nINSERTED\nbeta\nTARGET line here\ndelta\n";
			const recorded = anchorFor(oldText, "TARGET line here", {
				revisionId: "rev1",
			});

			const result = await resolveAnchor(
				recorded,
				newText,
				async () => oldText,
				identity,
			);

			expect(result.status).toBe("anchored");
			expect(result.method).toBe("revision-replay");
			const expectedFrom = newText.indexOf("TARGET line here");
			expect(result.range).toEqual({
				from: expectedFrom,
				to: expectedFrom + "TARGET line here".length,
			});
		});
	});

	describe("R12 — an edit through the anchored text orphans rather than guesses", () => {
		it("orphans when the anchored line itself was edited", async () => {
			const oldText = "alpha\nbeta\nTARGET line here\ndelta\n";
			const newText = "alpha\nbeta\nTARGET line changed\ndelta\n";
			const recorded = anchorFor(oldText, "TARGET line here", {
				revisionId: "rev1",
			});

			const result = await resolveAnchor(
				recorded,
				newText,
				async () => oldText,
				identity,
			);

			expect(result.status).toBe("orphaned");
			expect(result.range).toBeUndefined();
		});
	});

	describe("R12 — deleted text orphans explicitly, never re-anchors on a look-alike", () => {
		it("orphans when the anchored text is gone entirely", async () => {
			const oldText = "alpha\nbeta\nTARGET line here\ndelta\n";
			const newText = "alpha\nbeta\ndelta\n";
			const recorded = anchorFor(oldText, "TARGET line here", {
				revisionId: "rev1",
			});

			const result = await resolveAnchor(
				recorded,
				newText,
				async () => oldText,
				identity,
			);

			expect(result.status).toBe("orphaned");
		});

		it("does not silently re-anchor onto a merely similar line", async () => {
			const oldText = "alpha\nbeta\nTARGET line here\ndelta\n";
			const newText = "alpha\nbeta\nTARGET line here (similar)\ndelta\n";
			const recorded = anchorFor(oldText, "TARGET line here", {
				revisionId: "rev1",
			});

			const result = await resolveAnchor(
				recorded,
				newText,
				async () => oldText,
				identity,
			);

			expect(result.status).toBe("orphaned");
		});
	});

	describe("R12 — quote+context fallback only when the revision blob is unavailable", () => {
		it("falls back to a unique quote match when the revision is gone", async () => {
			const current = "alpha\nbeta\nTARGET line here\ndelta\n";
			const recorded: TextAnchor = {
				from: 999,
				to: 1010,
				quote: "TARGET line here",
				mode: "revision",
				revisionId: "gone",
			};

			const result = await resolveAnchor(
				recorded,
				current,
				async () => null,
				identity,
			);

			expect(result.status).toBe("fallback-anchored");
			expect(result.method).toBe("quote-context");
			const expectedFrom = current.indexOf("TARGET line here");
			expect(result.range).toEqual({
				from: expectedFrom,
				to: expectedFrom + "TARGET line here".length,
			});
		});

		it("does not fall back to quote matching when the revision blob IS available but replay fails", async () => {
			// Revision is available, but the anchored text was edited through —
			// per R12 this must orphan, never silently fall back to a quote scan.
			const oldText = "alpha\nTARGET\ndelta\n";
			const newText = "alpha\nCHANGED\ndelta\nTARGET\n";
			const recorded = anchorFor(oldText, "TARGET", { revisionId: "rev1" });

			const result = await resolveAnchor(
				recorded,
				newText,
				async () => oldText,
				identity,
			);

			expect(result.status).toBe("orphaned");
		});
	});

	describe("R10 — quote-mode anchors always resolve via quote+context", () => {
		it("resolves a quote-mode anchor without ever consulting the revision reader", async () => {
			const current = "alpha\nTARGET\ndelta\n";
			const recorded: TextAnchor = {
				from: 0,
				to: 6,
				quote: "TARGET",
				mode: "quote",
			};

			const readRevisionContent = async (): Promise<string | null> => {
				throw new Error("must not be called for mode:'quote'");
			};

			const result = await resolveAnchor(recorded, current, readRevisionContent, identity);

			expect(result.status).toBe("fallback-anchored");
			expect(result.method).toBe("quote-context");
		});
	});

	describe("R12 — ambiguous quotes orphan unless context disambiguates", () => {
		it("orphans a repeated quote with no recorded context", async () => {
			const current = "foo bar\nsome\ntext\nfoo bar";
			const recorded: TextAnchor = {
				from: 0,
				to: 3,
				quote: "foo",
				mode: "quote",
			};

			const result = await resolveAnchor(recorded, current, async () => null, identity);

			expect(result.status).toBe("orphaned");
		});

		it("resolves a repeated quote when the recorded context is unique", async () => {
			const current = "foo-unique\nsome\ntext\nfoo-other";
			const recorded: TextAnchor = {
				from: 0,
				to: 3,
				quote: "foo",
				mode: "quote",
				contextAfter: "-unique",
			};

			const result = await resolveAnchor(recorded, current, async () => null, identity);

			expect(result.status).toBe("fallback-anchored");
			expect(result.range).toEqual({ from: 0, to: 3 });
		});

		it("orphans when even the recorded context matches more than one occurrence", async () => {
			const current = "foo bar\nsome\ntext\nfoo bar";
			const recorded: TextAnchor = {
				from: 0,
				to: 3,
				quote: "foo",
				mode: "quote",
				contextAfter: " bar",
			};

			const result = await resolveAnchor(recorded, current, async () => null, identity);

			expect(result.status).toBe("orphaned");
		});
	});

	describe("no match at all orphans rather than guessing", () => {
		it("orphans when the quote is absent from the current text", async () => {
			const recorded: TextAnchor = {
				from: 0,
				to: 6,
				quote: "TARGET",
				mode: "quote",
			};

			const result = await resolveAnchor(
				recorded,
				"completely\nunrelated\ntext\nhere",
				async () => null,
				identity,
			);

			expect(result.status).toBe("orphaned");
		});
	});

	describe("emoji / surrogate pairs never split mid-character", () => {
		it("keeps a range containing a surrogate pair intact through an unrelated insertion above", async () => {
			const emoji = "\u{1F600}"; // 😀, a surrogate pair in UTF-16
			const oldText = `alpha\nlook ${emoji} here\ndelta\n`;
			const newText = `alpha\nINSERTED\nlook ${emoji} here\ndelta\n`;
			const quote = `${emoji} here`;
			const recorded = anchorFor(oldText, quote, { revisionId: "rev1" });

			const result = await resolveAnchor(
				recorded,
				newText,
				async () => oldText,
				identity,
			);

			expect(result.status).toBe("anchored");
			const expectedFrom = newText.indexOf(quote);
			expect(result.range).toEqual({
				from: expectedFrom,
				to: expectedFrom + quote.length,
			});
		});
	});
});
