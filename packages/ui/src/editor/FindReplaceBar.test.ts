// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import {
	combineFindReplaceMatches,
	findMatchesAffectedByTransaction,
	focusEditorAfterFindClose,
	nextFindReplaceHighlight,
	scrollEditorViewportFromFindBarWheel,
	shouldDispatchFindReplaceHighlight,
	shouldScrollActiveEditorMatch,
} from "./FindReplaceBar";

describe("combineFindReplaceMatches", () => {
	it("orders properties before body matches to follow rendered file order", () => {
		expect(
			combineFindReplaceMatches(
				[{ from: 10, to: 15, text: "alpha" }],
				[{ from: 0, to: 5, text: "alpha" }],
			),
		).toEqual([
			{ scope: "frontMatter", match: { from: 0, to: 5, text: "alpha" } },
			{ scope: "body", match: { from: 10, to: 15, text: "alpha" } },
		]);
	});
});

describe("scrollEditorViewportFromFindBarWheel", () => {
	it("forwards wheel scrolling from the find bar to the editor viewport", () => {
		const editorRoot = document.createElement("div");
		const viewport = document.createElement("div");
		const findBar = document.createElement("search");
		const preventDefault = vi.fn();
		const scrollBy = vi.fn();

		editorRoot.dataset.hubbleEditor = "";
		viewport.className = "editorViewport";
		viewport.scrollBy = scrollBy;
		editorRoot.append(viewport, findBar);
		document.body.append(editorRoot);

		scrollEditorViewportFromFindBarWheel(findBar, {
			deltaX: 4,
			deltaY: 64,
			preventDefault,
		});

		expect(preventDefault).toHaveBeenCalledOnce();
		expect(scrollBy).toHaveBeenCalledWith({
			behavior: "auto",
			left: 4,
			top: 64,
		});
	});
});

describe("shouldScrollActiveEditorMatch", () => {
	it("only scrolls body matches while find is open", () => {
		const bodyMatch = {
			scope: "body" as const,
			match: { from: 1, to: 6, text: "alpha" },
		};
		const frontMatterMatch = {
			scope: "frontMatter" as const,
			match: { from: 0, to: 5, text: "alpha" },
		};

		expect(shouldScrollActiveEditorMatch(true, bodyMatch)).toBe(true);
		expect(shouldScrollActiveEditorMatch(false, bodyMatch)).toBe(false);
		expect(shouldScrollActiveEditorMatch(true, frontMatterMatch)).toBe(false);
		expect(shouldScrollActiveEditorMatch(true, null)).toBe(false);
	});
});

describe("findMatchesAffectedByTransaction", () => {
	// Regression guard for the background-OOM storm: the highlight dispatch is a
	// meta-only transaction (docChanged=false). If a meta-only transaction were
	// treated as affecting matches, the revision bump → fresh bodyMatches →
	// re-dispatch feedback loop would pile up React updates until the renderer
	// ran out of memory. Only document changes may recompute matches.
	it("recomputes matches only for document-changing transactions", () => {
		expect(findMatchesAffectedByTransaction({ docChanged: true })).toBe(true);
		expect(findMatchesAffectedByTransaction({ docChanged: false })).toBe(false);
	});
});

describe("nextFindReplaceHighlight", () => {
	it("highlights body matches while open and clears otherwise", () => {
		const matches = [{ from: 1, to: 6, text: "alpha" }];
		expect(nextFindReplaceHighlight(true, matches, 0)).toEqual({
			matches,
			activeIndex: 0,
		});
		expect(nextFindReplaceHighlight(false, matches, 0)).toBeNull();
		expect(nextFindReplaceHighlight(true, [], -1)).toBeNull();
	});
});

describe("shouldDispatchFindReplaceHighlight", () => {
	it("skips no-op clears so a re-render never self-feeds a transaction", () => {
		expect(shouldDispatchFindReplaceHighlight(null, null)).toBe(false);
		expect(shouldDispatchFindReplaceHighlight(undefined, null)).toBe(false);
	});

	it("dispatches when the highlight appears, changes, or must be cleared", () => {
		const highlight = {
			matches: [{ from: 1, to: 6, text: "a" }],
			activeIndex: 0,
		};
		expect(shouldDispatchFindReplaceHighlight(null, highlight)).toBe(true);
		expect(shouldDispatchFindReplaceHighlight(highlight, null)).toBe(true);
		expect(shouldDispatchFindReplaceHighlight(highlight, highlight)).toBe(true);
	});
});

describe("focusEditorAfterFindClose", () => {
	it("restores editor focus without scrolling the previous find selection into view", () => {
		const focus = vi.fn();

		focusEditorAfterFindClose({
			commands: { focus },
		} as never);

		expect(focus).toHaveBeenCalledWith(undefined, { scrollIntoView: false });
	});
});
