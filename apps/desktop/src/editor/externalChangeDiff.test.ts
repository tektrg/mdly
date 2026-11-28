// @vitest-environment happy-dom
import {
	markdownToTiptapDoc,
	tableExtensions,
	tiptapDocToMarkdown,
} from "@mdly/workspace-kit";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildExternalChangeSuggestions,
	diffExternalDocs,
} from "./externalChangeDiff";
import {
	type GroupSettled,
	getSuggestions,
	SuggestionExtension,
} from "./SuggestionExtension";

const editors: Editor[] = [];
afterEach(() => {
	for (const e of editors) e.destroy();
	editors.length = 0;
});

function setupMarkdown(currentMarkdown: string) {
	const settled: GroupSettled[] = [];
	const element = document.createElement("div");
	document.body.append(element);
	const editor = new Editor({
		element,
		extensions: [
			StarterKit,
			...tableExtensions,
			SuggestionExtension.configure({ onGroupSettled: (s) => settled.push(s) }),
		],
		content: markdownToTiptapDoc(currentMarkdown),
	});
	editors.push(editor);
	return { editor, settled };
}

describe("externalChangeDiff + applied SuggestionExtension", () => {
	it("shows word-level inline diff for an edited paragraph; Keep keeps new, Undo reverts", () => {
		const prev = "The quick brown fox jumps.";
		const curr = "The slow brown fox leaps.";
		const { editor, settled } = setupMarkdown(curr);

		const { changes, frontMatterChanged } = buildExternalChangeSuggestions(
			prev,
			curr,
			editor.state.doc,
			editor.schema,
			"ext-1",
		);
		expect(frontMatterChanged).toBe(false);
		expect(changes.map((c) => `${c.before}->${c.insert}`)).toEqual([
			"quick->slow",
			"jumps->leaps",
		]);

		editor.commands.setAppliedSuggestions("external", changes);
		const html = editor.view.dom.innerHTML;
		expect(html).toContain("mdly-sugg-del");
		expect(html).toContain("mdly-sugg-ins");
		expect(html).toContain("mdly-sugg-block");

		// Keep first ("slow"), Undo second ("leaps" -> "jumps").
		const [first, second] = getSuggestions(editor.state);
		editor.commands.acceptSuggestion(first.id);
		expect(editor.getText()).toBe("The slow brown fox leaps.");
		expect(settled).toEqual([]);

		editor.commands.rejectSuggestion(second.id);
		expect(editor.getText()).toBe("The slow brown fox jumps.");
		expect(settled).toEqual([
			{
				groupId: "ext-1",
				source: "external",
				accepted: 1,
				rejected: 1,
				before: "quick jumps",
				after: "slow leaps",
			},
		]);
	});

	it("handles added whole blocks (block-add): Keep leaves, Undo deletes", () => {
		const prev = "First paragraph.";
		const curr = "First paragraph.\n\nSecond paragraph added by agent.";
		const { editor } = setupMarkdown(curr);

		const { changes } = buildExternalChangeSuggestions(
			prev,
			curr,
			editor.state.doc,
			editor.schema,
			"ext-2",
		);
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("block-add");

		editor.commands.setAppliedSuggestions("external", changes);
		expect(editor.view.dom.innerHTML).toContain("mdly-sugg-block-ins");

		editor.commands.rejectAllSuggestions();
		expect(editor.getText({ blockSeparator: "|" })).toBe("First paragraph.");
	});

	it("handles deleted whole blocks (block-del): renders ghost and Undo restores block", () => {
		const prev = "Keep me.\n\nDeleted paragraph.\n\nTail.";
		const curr = "Keep me.\n\nTail.";
		const { editor } = setupMarkdown(curr);

		const { changes } = buildExternalChangeSuggestions(
			prev,
			curr,
			editor.state.doc,
			editor.schema,
			"ext-3",
		);
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("block-del");
		expect(changes[0].before).toBe("Deleted paragraph.");

		editor.commands.setAppliedSuggestions("external", changes);
		expect(editor.view.dom.innerHTML).toContain("mdly-sugg-block-del");

		editor.commands.rejectAllSuggestions();
		expect(editor.getText({ blockSeparator: "|" })).toBe(
			"Keep me.|Deleted paragraph.|Tail.",
		);
	});

	it("handles block type or formatting-only changes (block-replace) and restores original", () => {
		const prev = "Plain paragraph.";
		const curr = "## Heading now.";
		const { editor } = setupMarkdown(curr);

		const { changes } = buildExternalChangeSuggestions(
			prev,
			curr,
			editor.state.doc,
			editor.schema,
			"ext-4",
		);
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("block-replace");

		editor.commands.setAppliedSuggestions("external", changes);
		editor.commands.rejectAllSuggestions();
		expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
		expect(tiptapDocToMarkdown(editor.getJSON() as JSONContent).trim()).toBe(
			"Plain paragraph.",
		);
	});

	it("recurses into bullet lists so single list-item edits stay word-level", () => {
		const prev = "- alpha one\n- beta two";
		const curr = "- alpha one\n- beta THREE";
		const { editor } = setupMarkdown(curr);

		const { changes } = buildExternalChangeSuggestions(
			prev,
			curr,
			editor.state.doc,
			editor.schema,
			"ext-5",
		);
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("inline");
		expect(changes[0].before).toBe("two");
		expect(changes[0].insert).toBe("THREE");

		editor.commands.setAppliedSuggestions("external", changes);
		editor.commands.rejectAllSuggestions();
		expect(tiptapDocToMarkdown(editor.getJSON() as JSONContent).trim()).toBe(
			"- alpha one\n- beta two",
		);
	});

	it("reverts a mixed document of inline, added, and deleted blocks in one Undo all", () => {
		const prev = "Intro line.\n\nOld middle.\n\nStay here.";
		const curr = "Intro edited.\n\nStay here.\n\nNew outro.";
		const { editor } = setupMarkdown(curr);
		const prevDoc = editor.schema.nodeFromJSON(markdownToTiptapDoc(prev));

		const changes = diffExternalDocs(prevDoc, editor.state.doc, "ext-6");
		expect(changes.length).toBeGreaterThanOrEqual(3);

		editor.commands.setAppliedSuggestions("external", changes);
		editor.commands.nextSuggestion(1);
		editor.commands.rejectAllSuggestions();
		expect(editor.getText({ blockSeparator: "|" })).toBe(
			"Intro line.|Old middle.|Stay here.",
		);
		expect(getSuggestions(editor.state)).toEqual([]);
	});

	it("detects frontmatter changes while diffing body cleanly", () => {
		const prev = "---\ntitle: Old\n---\n\nHello world.";
		const curr = "---\ntitle: New\n---\n\nHello world.";
		const { editor } = setupMarkdown("Hello world.");

		const result = buildExternalChangeSuggestions(
			prev,
			curr,
			editor.state.doc,
			editor.schema,
			"ext-7",
		);
		expect(result.frontMatterChanged).toBe(true);
		expect(result.changes).toEqual([]);
	});

	it("clearSuggestionsBySource removes external changes without dropping agent suggestions", () => {
		const { editor } = setupMarkdown("Hello world.\n\nAdded block.");
		const { changes } = buildExternalChangeSuggestions(
			"Hello world.",
			"Hello world.\n\nAdded block.",
			editor.state.doc,
			editor.schema,
			"ext-8",
		);
		editor.commands.addSuggestion({
			groupId: "agent-1",
			source: "agent",
			from: 1,
			to: 6,
			newText: "Hi",
		});
		editor.commands.setAppliedSuggestions("external", changes);
		expect(getSuggestions(editor.state).map((c) => c.source)).toEqual([
			"agent",
			"external",
		]);

		editor.commands.clearSuggestionsBySource("external");
		expect(getSuggestions(editor.state).map((c) => c.source)).toEqual([
			"agent",
		]);
	});

	it("ignores random table uids so unchanged tables produce zero diff", () => {
		const md = "| Finding | Evidence |\n| --- | --- |\n| A | B |";
		const { editor } = setupMarkdown(md);
		const { changes } = buildExternalChangeSuggestions(
			md,
			md,
			editor.state.doc,
			editor.schema,
			"ext-tbl-1",
		);
		expect(changes).toEqual([]);
	});

	it("diffs edited table cells inline at word level and reverts cleanly", () => {
		const prev =
			"| Finding | Evidence |\n| --- | --- |\n| Row 1 | 100 unread reports |\n| Row 2 | unchanged |";
		const curr =
			"| Finding | Evidence |\n| --- | --- |\n| Row 1 | 837 unread reports |\n| Row 2 | unchanged |";
		const { editor } = setupMarkdown(curr);

		const { changes } = buildExternalChangeSuggestions(
			prev,
			curr,
			editor.state.doc,
			editor.schema,
			"ext-tbl-2",
		);
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("inline");
		expect(changes[0].before).toBe("100");
		expect(changes[0].insert).toBe("837");

		editor.commands.setAppliedSuggestions("external", changes);
		expect(editor.view.dom.innerHTML).toContain("mdly-sugg-del");
		expect(editor.view.dom.innerHTML).toContain("mdly-sugg-ins");

		editor.commands.rejectAllSuggestions();
		expect(tiptapDocToMarkdown(editor.getJSON() as JSONContent)).toContain(
			"100 unread reports",
		);
	});

	it("handles added and deleted table rows as row-level diffs inside tbody", () => {
		const prev = "| Col |\n| --- |\n| Keep |\n| Removed row |";
		const curr = "| Col |\n| --- |\n| Keep |\n| Added row |";
		const { editor } = setupMarkdown(curr);

		const { changes } = buildExternalChangeSuggestions(
			prev,
			curr,
			editor.state.doc,
			editor.schema,
			"ext-tbl-3",
		);
		// Paired row edit -> inline word diff ("Removed" -> "Added")
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("inline");

		// Pure deleted row renders as <tr class="mdly-sugg-row-del">
		const currDeleted = "| Col |\n| --- |\n| Keep |";
		const { editor: ed2 } = setupMarkdown(currDeleted);
		const delResult = buildExternalChangeSuggestions(
			prev,
			currDeleted,
			ed2.state.doc,
			ed2.schema,
			"ext-tbl-4",
		);
		expect(delResult.changes).toHaveLength(1);
		expect(delResult.changes[0].kind).toBe("block-del");
		ed2.commands.setAppliedSuggestions("external", delResult.changes);
		expect(ed2.view.dom.querySelector("tr.mdly-sugg-row-del")).not.toBeNull();
		ed2.commands.rejectAllSuggestions();
		expect(tiptapDocToMarkdown(ed2.getJSON() as JSONContent)).toContain(
			"Removed row",
		);
	});

	it("renders a deleted whole table as an HTML table inside the ghost block", () => {
		const prev = "Intro.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
		const curr = "Intro.";
		const { editor } = setupMarkdown(curr);

		const { changes } = buildExternalChangeSuggestions(
			prev,
			curr,
			editor.state.doc,
			editor.schema,
			"ext-tbl-5",
		);
		expect(changes).toHaveLength(1);
		expect(changes[0].kind).toBe("block-del");
		editor.commands.setAppliedSuggestions("external", changes);
		expect(
			editor.view.dom.querySelector(".mdly-sugg-block-del table"),
		).not.toBeNull();
	});
});
