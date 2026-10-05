import { describe, expect, it } from "vitest";
import { parseMarkdownFrontMatter } from "./frontMatter";
import { setFrontMatterValue } from "./frontMatterEdit";

function edit(
	text: string,
	key: string,
	value: Parameters<typeof setFrontMatterValue>[2],
) {
	const result = setFrontMatterValue(text, key, value);
	if (!result.ok) throw new Error(`refused: ${result.reason}`);
	return result.text;
}

function refusal(
	text: string,
	key: string,
	value: Parameters<typeof setFrontMatterValue>[2],
) {
	const result = setFrontMatterValue(text, key, value);
	expect(result.ok).toBe(false);
	return result.ok ? "" : result.reason;
}

describe("setFrontMatterValue: replacing a value", () => {
	it("changes only the target line of a plain value", () => {
		const text =
			"---\ntitle: Plan\nstatus: todo\ndue: 2026-10-01\n---\n# Body\n";
		expect(edit(text, "status", "doing")).toBe(
			"---\ntitle: Plan\nstatus: doing\ndue: 2026-10-01\n---\n# Body\n",
		);
	});

	it("keeps double quotes when the value was double-quoted", () => {
		expect(edit('---\nstatus: "todo"\n---\n', "status", 'say "hi"')).toBe(
			'---\nstatus: "say \\"hi\\""\n---\n',
		);
	});

	it("keeps single quotes and escapes an apostrophe YAML-style", () => {
		expect(edit("---\nstatus: 'todo'\n---\n", "status", "don't")).toBe(
			"---\nstatus: 'don''t'\n---\n",
		);
	});

	it("quotes a plain value that would otherwise change type", () => {
		expect(edit("---\nstatus: todo\n---\n", "status", "true")).toBe(
			'---\nstatus: "true"\n---\n',
		);
		expect(edit("---\nstatus: todo\n---\n", "status", "a: b")).toBe(
			'---\nstatus: "a: b"\n---\n',
		);
	});

	it("writes numbers and booleans unquoted", () => {
		expect(edit("---\nn: 1\nok: false\n---\n", "n", 2.5)).toBe(
			"---\nn: 2.5\nok: false\n---\n",
		);
		expect(edit("---\nn: 1\nok: false\n---\n", "ok", true)).toBe(
			"---\nn: 1\nok: true\n---\n",
		);
	});

	it("keeps a comment on the edited line and comments elsewhere", () => {
		const text =
			"---\n# heading comment\nstatus: todo   # workflow state\n\n# trailing\n---\nbody";
		expect(edit(text, "status", "done")).toBe(
			"---\n# heading comment\nstatus: done   # workflow state\n\n# trailing\n---\nbody",
		);
	});

	it("keeps a comment after a quoted value", () => {
		expect(edit('---\nstatus: "a # b" # real\n---\n', "status", "c")).toBe(
			'---\nstatus: "c" # real\n---\n',
		);
	});

	it("fills an empty value and keeps its comment", () => {
		expect(edit("---\nstatus:\nx: 1\n---\n", "status", "todo")).toBe(
			"---\nstatus: todo\nx: 1\n---\n",
		);
		expect(edit("---\nstatus: # pick one\n---\n", "status", "todo")).toBe(
			"---\nstatus: todo # pick one\n---\n",
		);
	});

	it("matches the key case-insensitively and keeps its spelling", () => {
		expect(edit("---\nStatus: todo\n---\n", "status", "done")).toBe(
			"---\nStatus: done\n---\n",
		);
	});

	it("rewrites an inline list in place", () => {
		expect(edit("---\ntags: [a, b] # t\n---\n", "tags", ["a", "c d"])).toBe(
			"---\ntags: [a, c d] # t\n---\n",
		);
		expect(edit('---\ntags: ["a"]\n---\n', "tags", ["x, y"])).toBe(
			'---\ntags: ["x, y"]\n---\n',
		);
	});

	it("rewrites a simple block list and keeps its indent", () => {
		expect(edit("---\ntags:\n  - a\n  - b\nz: 1\n---\n", "tags", ["c"])).toBe(
			"---\ntags:\n  - c\nz: 1\n---\n",
		);
	});

	it("handles unicode values and keys", () => {
		expect(
			edit("---\nstatus: việc cần làm\n---\nThân bài ✓", "status", "xong 🎉"),
		).toBe("---\nstatus: xong 🎉\n---\nThân bài ✓");
	});
});

describe("setFrontMatterValue: bytes outside the edit", () => {
	it("preserves CRLF line endings, including on an appended key", () => {
		const text = "---\r\ntitle: A\r\nstatus: todo\r\n---\r\nbody\r\n";
		expect(edit(text, "status", "done")).toBe(
			"---\r\ntitle: A\r\nstatus: done\r\n---\r\nbody\r\n",
		);
		expect(edit(text, "due", "2026-10-05")).toBe(
			"---\r\ntitle: A\r\nstatus: todo\r\ndue: 2026-10-05\r\n---\r\nbody\r\n",
		);
	});

	it("preserves a BOM", () => {
		expect(edit("﻿---\nstatus: todo\n---\nx", "status", "done")).toBe(
			"﻿---\nstatus: done\n---\nx",
		);
	});

	it("leaves a body containing --- byte-for-byte", () => {
		const body = "\nIntro\n\n---\n\nstatus: not front matter\n---\n";
		const text = `---\nstatus: todo\n---${body}`;
		expect(edit(text, "status", "done")).toBe(`---\nstatus: done\n---${body}`);
	});

	it("keeps other keys' order and formatting untouched", () => {
		const text =
			"---\nz:   'one'\na: \"two\"\nlist:\n  - x\nstatus: todo\nm: {k: v}\n---\n";
		expect(edit(text, "status", "done")).toBe(text.replace("todo", "done"));
	});
});

describe("setFrontMatterValue: adding and removing", () => {
	it("creates a block when the note has none", () => {
		expect(edit("# Title\n", "status", "todo")).toBe(
			"---\nstatus: todo\n---\n# Title\n",
		);
		expect(edit("﻿body\r\n", "status", "todo")).toBe(
			"﻿---\r\nstatus: todo\r\n---\r\nbody\r\n",
		);
	});

	it("fills an empty block", () => {
		expect(edit("---\n---\nbody", "status", "todo")).toBe(
			"---\nstatus: todo\n---\nbody",
		);
	});

	it("appends an absent key after the last property, before trailing blanks", () => {
		expect(edit("---\na: 1\n\n---\n", "status", "todo")).toBe(
			"---\na: 1\nstatus: todo\n\n---\n",
		);
	});

	it("removes a key with null, and is a no-op when it is absent", () => {
		expect(edit("---\na: 1\nstatus: todo\nb: 2\n---\n", "status", null)).toBe(
			"---\na: 1\nb: 2\n---\n",
		);
		const result = setFrontMatterValue("---\na: 1\n---\n", "status", null);
		expect(result).toEqual({
			ok: true,
			text: "---\na: 1\n---\n",
			changed: false,
		});
		expect(setFrontMatterValue("body", "status", null)).toMatchObject({
			ok: true,
			changed: false,
		});
	});

	it("reports changed: false when the value is already there", () => {
		expect(
			setFrontMatterValue("---\nstatus: todo\n---\n", "status", "todo"),
		).toMatchObject({
			ok: true,
			changed: false,
		});
	});
});

describe("setFrontMatterValue: refusals", () => {
	it("refuses malformed YAML", () => {
		refusal("---\nstatus: [unclosed\n---\n", "status", "x");
		refusal("---\n: : :\n  bad: - indent\n---\n", "status", "x");
	});

	it("refuses duplicate keys, including case variants", () => {
		expect(refusal("---\nstatus: a\nstatus: b\n---\n", "status", "x")).toMatch(
			/repeats/,
		);
		expect(refusal("---\nStatus: a\nstatus: b\n---\n", "other", "x")).toMatch(
			/repeats/,
		);
	});

	it("refuses an unclosed block", () => {
		refusal("---\nstatus: todo\n", "status", "x");
	});

	it("refuses block scalars and other multi-line values", () => {
		refusal("---\nstatus: |\n  multi\n  line\n---\n", "status", "x");
		refusal("---\nstatus: >\n  folded\n---\n", "status", "x");
		refusal("---\nstatus:\n  nested: map\n---\n", "status", "x");
		refusal("---\ntags:\n  - a\n---\n", "tags", "scalar");
		refusal('---\nstatus: "multi\n  line"\n---\n', "status", "x");
	});

	it("refuses anchors, aliases and tags", () => {
		refusal("---\nstatus: &s todo\n---\n", "status", "x");
		refusal("---\nbase: &b 1\nstatus: *b\n---\n", "status", "x");
		refusal("---\nstatus: !!str todo\n---\n", "status", "x");
	});

	it("refuses a new key that is not a simple name", () => {
		refusal("---\na: 1\n---\n", "has space", "x");
	});

	it("refuses a non-map block", () => {
		refusal("---\n- a\n- b\n---\n", "status", "x");
	});
});

// --- property-based round trip -------------------------------------------

function seededRandom(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

const SCALAR_FORMS = [
	(v: string) => v,
	(v: string) => `"${v}"`,
	(v: string) => `'${v}'`,
	(v: string) => `${v}   # note ${v}`,
	(v: string) => `[${v}, x]`,
	() => "42",
	() => "true",
	() => "2026-01-02",
	() => "",
];
const WORDS = ["todo", "Done", "việc", "🎉ok", "a-b", "x_y", "Plan 2"];
const KEYS = ["title", "status", "due", "tags", "Owner", "n", "kind"];

function randomDocument(random: () => number) {
	const pick = <T>(list: readonly T[]) =>
		list[Math.floor(random() * list.length)] as T;
	const eol = random() < 0.3 ? "\r\n" : "\n";
	const bom = random() < 0.2 ? "﻿" : "";
	const keys = KEYS.filter(() => random() < 0.6);
	const lines: string[] = [];
	for (const key of keys) {
		if (random() < 0.2) lines.push(`# about ${key}`);
		if (random() < 0.1) lines.push("");
		const value = pick(SCALAR_FORMS)(pick(WORDS));
		lines.push(value === "" ? `${key}:` : `${key}: ${value}`);
	}
	const body = pick([
		"",
		`${eol}# H${eol}---${eol}text ✓`,
		"plain",
		`${eol}${eol}`,
	]);
	return {
		text: `${bom}---${eol}${lines.map((line) => line + eol).join("")}---${eol}${body}`,
		keys,
	};
}

/** Lines that differ between two texts with the same line count. */
function changedLineIndexes(before: string, after: string): number[] {
	const a = before.split("\n");
	const b = after.split("\n");
	if (a.length !== b.length) return [-1];
	return a.flatMap((line, index) => (line === b[index] ? [] : [index]));
}

describe("setFrontMatterValue: random round trips", () => {
	it("changes exactly one line, every other byte identical, value reads back", () => {
		const random = seededRandom(20261005);
		let edits = 0;
		for (let run = 0; run < 400; run += 1) {
			const { text, keys } = randomDocument(random);
			if (keys.length === 0) continue;
			const key = keys[Math.floor(random() * keys.length)] as string;
			const nextValue = WORDS[Math.floor(random() * WORDS.length)] as string;
			const result = setFrontMatterValue(text, key, nextValue);
			if (!result.ok)
				throw new Error(`${result.reason}\n${JSON.stringify(text)}`);
			edits += 1;
			const changed = changedLineIndexes(text, result.text);
			expect(changed.length).toBeLessThanOrEqual(1);
			const parsed = parseMarkdownFrontMatter(result.text);
			expect(parsed.type).toBe("valid");
			if (parsed.type !== "valid") continue;
			const property = parsed.properties.find(
				(candidate) => candidate.key.toLowerCase() === key.toLowerCase(),
			);
			expect(property && "value" in property ? property.value : null).toBe(
				nextValue,
			);
			// Restoring every other line: setting the old line back gives the input.
			if (changed.length === 1) {
				const index = changed[0] as number;
				const restored = result.text.split("\n");
				restored[index] = text.split("\n")[index] as string;
				expect(restored.join("\n")).toBe(text);
			}
			// Removing then re-adding keeps the body byte-for-byte.
			const removed = setFrontMatterValue(result.text, key, null);
			expect(removed.ok).toBe(true);
			if (removed.ok) {
				const bodyOf = (value: string) => value.slice(value.indexOf("---", 3));
				expect(bodyOf(removed.text)).toBe(bodyOf(text));
			}
		}
		expect(edits).toBeGreaterThan(300);
	});
});

describe("setFrontMatterValue: QA pass 1", () => {
	it("quotes YAML 1.1 boolean words in any case", () => {
		for (const word of ["yes", "No", "ON", "off", "y", "N", "null", "~"]) {
			expect(edit("---\nstatus: todo\n---\n", "status", word)).toBe(
				`---\nstatus: ${JSON.stringify(word)}\n---\n`,
			);
		}
	});

	it("refuses front matter that starts after blank lines instead of prepending", () => {
		expect(refusal("\n\n---\nstatus: todo\n---\nbody", "status", "x")).toMatch(
			/first line/,
		);
		expect(refusal("\r\n---\r\n---\r\n", "status", "x")).toMatch(/first line/);
	});

	it("rewrites an Obsidian-style column-0 list under its key", () => {
		expect(edit("---\ntags:\n- a\n- b\nz: 1\n---\n", "tags", ["c", "d"])).toBe(
			"---\ntags:\n- c\n- d\nz: 1\n---\n",
		);
		expect(edit("---\ntags:\n- a\nstatus: x\n---\n", "status", "later")).toBe(
			"---\ntags:\n- a\nstatus: later\n---\n",
		);
	});
});

describe("setFrontMatterValue: refusal wording", () => {
	it("explains refusals in plain English, without YAML jargon", () => {
		const cases: [string, string][] = [
			["---\nstatus: [unclosed\n---\n", "status"],
			["---\nstatus: a\nstatus: b\n---\n", "status"],
			["---\nstatus: todo\n", "status"],
			["---\nstatus: |\n  x\n---\n", "status"],
			["\n---\na: 1\n---\n", "status"],
		];
		for (const [text, key] of cases) {
			const reason = refusal(text, key, "x");
			expect(reason).not.toMatch(/YAML|front matter|scalar|block/i);
		}
	});
});
