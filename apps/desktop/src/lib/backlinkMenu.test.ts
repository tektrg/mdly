import { describe, expect, it } from "vitest";
import { backlinkMenuEntries } from "./backlinkMenu";

describe("backlinkMenuEntries", () => {
	it("lists each linking doc once, by name, A→Z", () => {
		const entries = backlinkMenuEntries(
			["/ws/zeta.md", "/ws/notes/Alpha.md", "/ws/zeta.md", "/ws/beta.md"],
			"/ws",
		);
		expect(entries).toEqual([
			{ path: "/ws/notes/Alpha.md", label: "Alpha", title: "notes/Alpha.md" },
			{ path: "/ws/beta.md", label: "beta", title: "beta.md" },
			{ path: "/ws/zeta.md", label: "zeta", title: "zeta.md" },
		]);
	});

	it("shows the folder when two linkers share a name", () => {
		const labels = backlinkMenuEntries(
			["/ws/b/index.md", "/ws/a/index.md", "/ws/other.md"],
			"/ws",
		).map((e) => e.label);
		expect(labels).toEqual(["a/index", "b/index", "other"]);
	});
});
