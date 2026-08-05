import { describe, expect, it } from "vitest";
import {
	combineMarkdownFrontMatter,
	detectFilePropertyType,
	parseDateInput,
	parseMarkdownFrontMatter,
	serializeFrontMatter,
} from "./frontMatter";

describe("front matter", () => {
	it("splits valid front matter from the markdown body", () => {
		const parsed = parseMarkdownFrontMatter(`---
title: Hello
published: false
count: 3
date: 2026-06-03
tags:
  - work
  - draft
---
# Body`);

		expect(parsed).toMatchObject({
			type: "valid",
			body: "# Body",
			properties: [
				{ key: "title", type: "text", value: "Hello" },
				{ key: "published", type: "checkbox", value: false },
				{ key: "count", type: "number", value: 3 },
				{ key: "date", type: "date", value: "2026-06-03" },
				{ key: "tags", type: "tags", value: ["work", "draft"] },
			],
		});
	});

	it("ignores repeated leading front matter blocks from Notion markdown exports", () => {
		const parsed = parseMarkdownFrontMatter(`---
AI Summary: First copy
PIC: []
---

---
AI Summary: Escaped duplicate copy
PIC: \\[\\]
---
# Body`);

		expect(parsed).toMatchObject({
			type: "valid",
			raw: "AI Summary: First copy\nPIC: []",
			body: "# Body",
			properties: [
				{ key: "AI Summary", type: "unsupported" },
				{ key: "PIC", type: "tags", value: [] },
			],
		});
	});

	it("keeps a second leading YAML block in the body when keys are not repeated", () => {
		const parsed = parseMarkdownFrontMatter(`---
title: Page title
---

---
example: body block
---
Content`);

		expect(parsed).toMatchObject({
			type: "valid",
			raw: "title: Page title",
			body: "\n---\nexample: body block\n---\nContent",
			properties: [{ key: "title", type: "text", value: "Page title" }],
		});
	});

	it("keeps a second leading YAML block in the body when keys only partially overlap", () => {
		const parsed = parseMarkdownFrontMatter(`---
Status: Draft
Name: Page title
---

---
Status: example
Description: body block
---
Content`);

		expect(parsed).toMatchObject({
			type: "valid",
			raw: "Status: Draft\nName: Page title",
			body: "\n---\nStatus: example\nDescription: body block\n---\nContent",
			properties: [
				{ key: "Status", type: "text", value: "Draft" },
				{ key: "Name", type: "text", value: "Page title" },
			],
		});
	});

	it("uses YAML 1.2 scalar behavior", () => {
		const parsed = parseMarkdownFrontMatter(`---
yes_value: yes
no_value: no
on_value: on
off_value: off
true_value: true
---
Body`);

		expect(parsed.type).toBe("valid");
		if (parsed.type !== "valid") return;
		expect(parsed.properties).toEqual([
			{ key: "yes_value", type: "text", value: "yes" },
			{ key: "no_value", type: "text", value: "no" },
			{ key: "on_value", type: "text", value: "on" },
			{ key: "off_value", type: "text", value: "off" },
			{ key: "true_value", type: "checkbox", value: true },
		]);
	});

	it("preserves invalid front matter and keeps body editable", () => {
		const parsed = parseMarkdownFrontMatter(`---
title: Test
broken: [one, two
---
# Body`);

		expect(parsed.type).toBe("invalid");
		if (parsed.type !== "invalid") return;
		expect(parsed.raw).toContain("broken");
		expect(parsed.body).toBe("# Body");
	});

	it("marks unsupported properties without hiding supported properties", () => {
		const parsed = parseMarkdownFrontMatter(`---
title: Visible
nested:
  child: value
flags:
  - true
  - false
published: true
---
Body`);

		expect(parsed.type).toBe("valid");
		if (parsed.type !== "valid") return;
		expect(parsed.properties).toEqual([
			{ key: "title", type: "text", value: "Visible" },
			{
				key: "nested",
				type: "unsupported",
				raw: "nested:\n  child: value",
				preview: "Object",
			},
			{
				key: "flags",
				type: "unsupported",
				raw: "flags:\n  - true\n  - false",
				preview: "true, false",
			},
			{ key: "published", type: "checkbox", value: true },
		]);
	});

	it("shows read-only previews for unsupported Notion-style property names", () => {
		const parsed = parseMarkdownFrontMatter(`---
AI Summary: Draft intro
Review Owners:
  - Ada
  - Ben
---
Body`);

		expect(parsed.type).toBe("valid");
		if (parsed.type !== "valid") return;
		expect(parsed.properties).toEqual([
			{
				key: "AI Summary",
				type: "unsupported",
				raw: "AI Summary: Draft intro",
				preview: "Draft intro",
			},
			{
				key: "Review Owners",
				type: "unsupported",
				raw: "Review Owners:\n  - Ada\n  - Ben",
				preview: "Ada, Ben",
			},
		]);
	});

	it("serializes supported properties as normalized YAML", () => {
		const yaml = serializeFrontMatter([
			{ key: "description", type: "text", value: 'Long text with "quotes"' },
			{ key: "title", type: "text", value: "true" },
			{ key: "date_text", type: "text", value: "2026-06-03" },
			{ key: "count", type: "number", value: 3 },
			{ key: "published", type: "checkbox", value: false },
			{ key: "date", type: "date", value: "2026-06-03" },
			{ key: "tags", type: "tags", value: ["work", "draft"] },
		]);

		expect(yaml).toBe(`description: "Long text with \\"quotes\\""
title: "true"
date_text: "2026-06-03"
count: 3
published: false
date: 2026-06-03
tags:
  - work
  - draft`);
	});

	it("preserves unsupported properties with non-simple keys while serializing edits", () => {
		const yaml = serializeFrontMatter([
			{
				key: "AI Summary",
				type: "unsupported",
				raw: "AI Summary: Draft intro",
				preview: "Draft intro",
			},
			{ key: "status", type: "text", value: "done" },
		]);

		expect(yaml).toBe(`AI Summary: Draft intro
status: "done"`);
	});

	it("preserves unsupported raw YAML source while serializing supported edits", () => {
		const parsed = parseMarkdownFrontMatter(`---
status: draft
AI Summary: >
  Hello
  world
# keep this with the next property
Nested Value: { child: "quoted", list: [one, two] }
---
Body`);

		expect(parsed.type).toBe("valid");
		if (parsed.type !== "valid") return;
		const nextProperties = parsed.properties.map((property) =>
			property.key === "status"
				? { ...property, type: "text" as const, value: "done" }
				: property,
		);

		expect(serializeFrontMatter(nextProperties)).toBe(`status: "done"
AI Summary: >
  Hello
  world
# keep this with the next property
Nested Value: { child: "quoted", list: [one, two] }`);
	});

	it("recombines front matter with a markdown body", () => {
		expect(combineMarkdownFrontMatter("title: Test", "# Body")).toBe(`---
title: Test
---
# Body`);
	});

	it("detects types only for complete stable values", () => {
		expect(detectFilePropertyType("2026-06-03")).toBe("date");
		expect(detectFilePropertyType("04/06/2025")).toBe("date");
		expect(detectFilePropertyType("2026-06-0")).toBe("text");
		expect(detectFilePropertyType("false")).toBe("checkbox");
		expect(detectFilePropertyType("123")).toBe("number");
		expect(detectFilePropertyType("yes")).toBe("text");
	});

	it("normalizes supported date input shapes", () => {
		expect(parseDateInput("2026-6-3")).toBe("2026-06-03");
		expect(parseDateInput("2026/06/03")).toBe("2026-06-03");
		expect(parseDateInput("04/06/2025")).toBe("2025-04-06");
		expect(parseDateInput("04-06-2025")).toBe("2025-04-06");
		expect(parseDateInput("13/40/2025")).toBeNull();
	});
});
