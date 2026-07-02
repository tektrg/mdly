// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import {
	combineFindReplaceMatches,
	focusEditorAfterFindClose,
	scrollEditorViewportFromFindBarWheel,
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

describe("focusEditorAfterFindClose", () => {
	it("restores editor focus without scrolling the previous find selection into view", () => {
		const focus = vi.fn();

		focusEditorAfterFindClose({
			commands: { focus },
		} as never);

		expect(focus).toHaveBeenCalledWith(undefined, { scrollIntoView: false });
	});
});
