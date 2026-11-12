/**
 * "Linked from" saved-view grouping: each group is a document that links to
 * others (titled by its name), its members the documents it links to.
 */
import { describe, expect, it } from "vitest";
import {
	batchLinkIndex,
	createLinkIndex,
	setLinkSource,
} from "../lib/linkIndex";
import type { NavDocument } from "./navGroupTree";
import {
	PATH_GROUP_BY,
	sanitizeSavedView,
	savedViewToRecord,
} from "./properties/documentViews";
import {
	buildPathGroupTree,
	linkedFromGroupSource,
} from "./properties/pathGroupTree";

const doc = (p: string): NavDocument => ({ path: `/ws/${p}`, folderPath: "" });

function indexOf(sources: Record<string, string>) {
	const index = createLinkIndex();
	for (const [p, content] of Object.entries(sources))
		setLinkSource(index, `/ws/${p}`, content, 1);
	return index;
}

const groups = (
	docs: NavDocument[],
	index: ReturnType<typeof createLinkIndex>,
) =>
	buildPathGroupTree(docs, PATH_GROUP_BY.linkedFrom, index).children.map(
		(g) => `${g.label}:${[...g.members].map((m) => m.slice(4)).join(",")}`,
	);

describe("Linked from grouping", () => {
	const index = indexOf({
		"hub.md": "[a](a.md) [b](b.md) [c](c.md) [self](hub.md)",
		"zeta.md": "[a](a.md) [b](b.md)",
		"alpha.md": "[c](c.md)",
		"a.md": "[a again](a.md)",
	});

	it("multi-membership, biggest first then A→Z, Other last, self-links ignored", () => {
		const docs = ["a.md", "b.md", "c.md", "hub.md", "alpha.md"].map(doc);
		expect(groups(docs, index)).toEqual([
			"hub:a.md,b.md,c.md",
			"zeta:a.md,b.md",
			"alpha:c.md",
			// hub links to itself only; alpha/zeta-less docs land here.
			"Other:hub.md,alpha.md",
		]);
	});

	it("members are only the filtered docs; a filtered-out linker still titles its group", () => {
		// zeta.md and hub.md are not in the view, but their targets are.
		expect(groups([doc("b.md")], index)).toEqual(["hub:b.md", "zeta:b.md"]);
		// Empty groups never appear.
		expect(groups([doc("c.md")], index)).toEqual(["alpha:c.md", "hub:c.md"]);
	});

	it("group id resolves back to the linking doc (for opening it)", () => {
		const [first] = buildPathGroupTree(
			[doc("c.md")],
			PATH_GROUP_BY.linkedFrom,
			index,
		).children;
		expect(linkedFromGroupSource(first?.id ?? "")).toBe("/ws/alpha.md");
		expect(linkedFromGroupSource("group:tag::x")).toBeNull();
	});

	it("without an index everything is Other; empty input has no groups", () => {
		expect(groups([doc("a.md")], createLinkIndex())).toEqual(["Other:a.md"]);
		expect(groups([], index)).toEqual([]);
	});

	it("round-trips through views.json as groupByKind: linked-from", () => {
		const base = sanitizeSavedView({ id: "v", name: "V" });
		if (!base) throw new Error("sanitize");
		const view = { ...base, groupBy: PATH_GROUP_BY.linkedFrom };
		const record = JSON.parse(JSON.stringify(savedViewToRecord(view)));
		expect(record).toMatchObject({ groupBy: null, groupByKind: "linked-from" });
		expect(sanitizeSavedView(record)).toEqual(view);
	});

	it("groups wiki-link sources too", () => {
		const wiki = indexOf({
			"hub.md": "[[a]] [[B|bee]] [[missing]]",
			"a.md": "",
			"b.md": "",
		});
		expect(groups([doc("a.md"), doc("b.md"), doc("hub.md")], wiki)).toEqual([
			"hub:a.md,b.md",
			"Other:hub.md",
		]);
	});

	it("indexes 50k docs with wiki links and groups them within budget", () => {
		const big = createLinkIndex("/ws");
		const docs: NavDocument[] = [];
		const start = performance.now();
		const end = batchLinkIndex(big); // as `syncLinkIndex` does
		for (let i = 0; i < 50_000; i += 1) {
			docs.push(doc(`f${i % 50}/d${i}.md`));
			const links =
				i % 10 === 0
					? Array.from(
							{ length: 20 },
							(_, k) => `[[d${(i * 7 + k * 13) % 50_000}]]`,
						).join(" ")
					: "";
			setLinkSource(big, `/ws/f${i % 50}/d${i}.md`, links, 1);
		}
		end();
		const indexMs = performance.now() - start;
		const tree = buildPathGroupTree(docs, PATH_GROUP_BY.linkedFrom, big);
		expect(tree.children.length).toBeGreaterThan(4000);
		// Pure in-memory work; file reads dominate a real sync.
		expect(indexMs).toBeLessThan(1500);
	});

	it("groups 50k docs in one pass within budget", () => {
		const big = createLinkIndex();
		const docs: NavDocument[] = [];
		for (let i = 0; i < 50_000; i += 1) {
			docs.push(doc(`d${i}.md`));
			if (i % 10 === 0) {
				const links = Array.from(
					{ length: 20 },
					(_, k) => `[x](d${(i * 7 + k * 13) % 50_000}.md)`,
				).join(" ");
				setLinkSource(big, `/ws/d${i}.md`, links, 1);
			}
		}
		buildPathGroupTree(docs, PATH_GROUP_BY.linkedFrom, big); // JIT warm-up
		const start = performance.now();
		const tree = buildPathGroupTree(docs, PATH_GROUP_BY.linkedFrom, big);
		const ms = performance.now() - start;
		expect(tree.children.length).toBeGreaterThan(4000);
		// ~60 ms on the Air (2026-11-12); loose for loaded machines.
		expect(ms).toBeLessThan(200);
	});
});
