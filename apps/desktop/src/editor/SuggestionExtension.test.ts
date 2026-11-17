// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
	findTextRange,
	type GroupSettled,
	getSuggestions,
	placeProposal,
	SuggestionExtension,
} from "./SuggestionExtension";

const editors: Editor[] = [];
afterEach(() => {
	for (const e of editors) e.destroy();
	editors.length = 0;
});

function setup(html: string) {
	const settled: GroupSettled[] = [];
	const element = document.createElement("div");
	document.body.append(element);
	const editor = new Editor({
		element,
		extensions: [
			StarterKit,
			SuggestionExtension.configure({ onGroupSettled: (s) => settled.push(s) }),
		],
		content: html,
	});
	editors.push(editor);
	return { editor, settled };
}

function suggest(
	editor: Editor,
	find: string,
	replace: string,
	groupId = "g1",
) {
	const range = findTextRange(editor.state.doc, find);
	if (!range) throw new Error("not found");
	return editor.commands.addSuggestion({
		groupId,
		source: "agent",
		...range,
		newText: replace,
	});
}

describe("SuggestionExtension", () => {
	it("splits into word changes and renders red/green without touching the doc", () => {
		const { editor } = setup("<p>The quick brown fox jumps.</p>");
		expect(
			suggest(editor, "quick brown fox jumps", "slow brown fox leaps"),
		).toBe(true);
		expect(
			getSuggestions(editor.state).map((c) => `${c.before}->${c.insert}`),
		).toEqual(["quick->slow", "jumps->leaps"]);
		expect(editor.getText()).toBe("The quick brown fox jumps.");
		const html = editor.view.dom.innerHTML;
		expect(html).toContain("mdly-sugg-del");
		expect(html).toContain("mdly-sugg-ins");
		expect(html).toContain("mdly-sugg-block");
	});

	it("accept one is a single undo step; reject leaves text; group settles once", () => {
		const { editor, settled } = setup("<p>The quick brown fox jumps.</p>");
		suggest(editor, "quick brown fox jumps", "slow brown fox leaps");
		const [first, second] = getSuggestions(editor.state);
		editor.commands.acceptSuggestion(first.id);
		expect(editor.getText()).toBe("The slow brown fox jumps.");
		expect(settled).toEqual([]);
		editor.commands.rejectSuggestion(second.id);
		expect(editor.getText()).toBe("The slow brown fox jumps.");
		expect(settled).toEqual([
			{
				groupId: "g1",
				source: "agent",
				accepted: 1,
				rejected: 1,
				before: "quick jumps",
				after: "slow leaps",
			},
		]);
		editor.commands.undo();
		expect(editor.getText()).toBe("The quick brown fox jumps.");
	});

	it("accept all applies every change in one step", () => {
		const { editor } = setup("<p>one two three</p><p>four five</p>");
		suggest(editor, "one two three", "one 2 three", "a");
		suggest(editor, "four five", "4 five", "b");
		editor.commands.acceptAllSuggestions();
		expect(editor.getText({ blockSeparator: "|" })).toBe("one 2 three|4 five");
		expect(getSuggestions(editor.state)).toEqual([]);
		editor.commands.undo();
		expect(editor.getText({ blockSeparator: "|" })).toBe(
			"one two three|four five",
		);
	});

	it("remaps over edits elsewhere, drops a change whose words were edited away", () => {
		const { editor } = setup("<p>alpha beta</p><p>gamma</p>");
		suggest(editor, "gamma", "delta");
		editor.commands.insertContentAt(1, "new ");
		expect(getSuggestions(editor.state)).toHaveLength(1);
		const [c] = getSuggestions(editor.state);
		editor.commands.insertContentAt(c.from + 1, "X");
		expect(getSuggestions(editor.state)).toEqual([]);
	});

	it("a group whose words were all edited away settles as rejected (agent is told)", () => {
		const { editor, settled } = setup("<p>one two three</p>");
		suggest(editor, "one two three", "uno two tres", "p1");
		expect(getSuggestions(editor.state)).toHaveLength(2);
		const [first] = getSuggestions(editor.state);
		editor.commands.insertContentAt(first.from + 1, "X");
		expect(getSuggestions(editor.state)).toHaveLength(1);
		expect(settled).toEqual([]); // one change still pending
		const [second] = getSuggestions(editor.state);
		editor.commands.insertContentAt(second.from + 1, "Y");
		expect(getSuggestions(editor.state)).toEqual([]);
		expect(settled).toHaveLength(1);
		expect(settled[0]).toMatchObject({
			groupId: "p1",
			accepted: 0,
			rejected: 2,
		});
	});

	it("next/previous moves the caret to changes", () => {
		const { editor } = setup("<p>a b c d</p>");
		suggest(editor, "a b c d", "a B c D");
		const [b, d] = getSuggestions(editor.state);
		editor.commands.setTextSelection(1);
		editor.commands.nextSuggestion(1);
		expect(editor.state.selection.head).toBe(b.from);
		editor.commands.nextSuggestion(1);
		expect(editor.state.selection.head).toBe(d.from);
		editor.commands.nextSuggestion(-1);
		expect(editor.state.selection.head).toBe(b.from);
	});

	it("inserts hostile text as inert text", () => {
		const { editor } = setup("<p>hello</p>");
		suggest(editor, "hello", "$(echo INJECTED)");
		editor.commands.acceptAllSuggestions();
		expect(editor.getText()).toBe("$(echo INJECTED)");
	});
});

describe("placeProposal (unambiguous anchoring)", () => {
	it("places a unique match", () => {
		const { editor } = setup("<p>alpha beta</p><p>gamma</p>");
		const placed = placeProposal(editor.state.doc, { find: "gamma" });
		expect(placed.ok).toBe(true);
	});
	it("rejects an ambiguous match without an occurrence hint", () => {
		const { editor } = setup("<p>the cat</p><p>the cat sat</p>");
		const placed = placeProposal(editor.state.doc, { find: "the cat" });
		expect(placed).toMatchObject({ ok: false, reason: "ambiguous" });
		if (!placed.ok) expect(placed.message).toMatch(/2 places/);
	});
	it("uses the occurrence hint (1-based, document order, same block too)", () => {
		const { editor } = setup("<p>a x a</p><p>a</p>");
		const second = placeProposal(editor.state.doc, {
			find: "a",
			occurrence: 2,
		});
		const third = placeProposal(editor.state.doc, { find: "a", occurrence: 3 });
		expect(second.ok && third.ok).toBe(true);
		if (second.ok && third.ok) {
			expect(editor.state.doc.textBetween(second.from, second.to)).toBe("a");
			expect(second.from).toBeLessThan(third.from);
			// second is in the first paragraph, third in the next one
			expect(editor.state.doc.resolve(second.from).index(0)).toBe(0);
			expect(editor.state.doc.resolve(third.from).index(0)).toBe(1);
		}
	});
	it("rejects an out-of-range occurrence and a missing text", () => {
		const { editor } = setup("<p>one</p>");
		expect(
			placeProposal(editor.state.doc, { find: "one", occurrence: 2 }),
		).toMatchObject({ ok: false, reason: "occurrence-out-of-range" });
		expect(placeProposal(editor.state.doc, { find: "two" })).toMatchObject({
			ok: false,
			reason: "not-found",
		});
	});
});
