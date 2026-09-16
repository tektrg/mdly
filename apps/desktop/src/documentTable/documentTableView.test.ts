import { beforeEach, describe, expect, it } from "vitest";
import type { FileEntry } from "../store/state";
import {
	applyDocumentTableView,
	buildDocumentRows,
	createDefaultDocumentTableView,
	type DocumentTableView,
	ROOT_FOLDER_LABEL,
	resetDocumentRowsMemo,
	toggleSort,
} from "./documentTableView";

const WORKSPACE = "/ws";

function file(path: string, modified_at = 100, extra?: Partial<FileEntry>) {
	return { path, modified_at, ...extra } satisfies FileEntry;
}

function viewWith(overrides?: Partial<DocumentTableView>): DocumentTableView {
	return { ...createDefaultDocumentTableView(), ...overrides };
}

function pathsFor(
	files: FileEntry[],
	view = createDefaultDocumentTableView(),
	activePath: string | null = null,
) {
	return applyDocumentTableView(
		buildDocumentRows(files, WORKSPACE),
		view,
		activePath,
	).map((row) => row.path);
}

describe("buildDocumentRows", () => {
	beforeEach(() => {
		resetDocumentRowsMemo();
	});

	it("keeps only markdown documents so every row is openable (R2)", () => {
		const rows = buildDocumentRows(
			[
				file("/ws/a.md"),
				file("/ws/b.markdown"),
				file("/ws/c.mdown"),
				file("/ws/app.html"),
				file("/ws/README.HTML"),
				file("/ws/img.png"),
			],
			WORKSPACE,
		);

		expect(rows.map((row) => row.path)).toEqual([
			"/ws/a.md",
			"/ws/b.markdown",
			"/ws/c.mdown",
		]);
	});

	it("excludes a symlink whose target is missing so no row is a dead click", () => {
		const rows = buildDocumentRows(
			[
				file("/ws/live.md", 100, {
					is_symlink: true,
					symlink_target_exists: true,
					symlink_canonical_path: "/elsewhere/target.md",
				}),
				file("/ws/dangling.md", 100, {
					is_symlink: true,
					symlink_target_exists: false,
					symlink_canonical_path: null,
				}),
			],
			WORKSPACE,
		);

		expect(rows.map((row) => row.path)).toEqual(["/ws/live.md"]);
		expect(rows[0].openPath).toBe("/elsewhere/target.md");
	});

	it("derives name, folder and modified from the listing without reading disk", () => {
		const rows = buildDocumentRows(
			[file("/ws/notes/release-notes.md", 1700000000), file("/ws/root.md", 5)],
			WORKSPACE,
		);

		expect(rows[0]).toMatchObject({
			path: "/ws/notes/release-notes.md",
			name: "release-notes",
			folderLabel: "notes",
			modifiedAt: 1700000000,
			isActive: false,
			isPinnedOffFilter: false,
		});
		expect(rows[1].folderLabel).toBe(ROOT_FOLDER_LABEL);
	});

	it("reprojects when the listing array is replaced (no stale memo)", () => {
		const first = [file("/ws/a.md", 1)];
		expect(buildDocumentRows(first, WORKSPACE)[0].modifiedAt).toBe(1);

		const second = [file("/ws/a.md", 999)];
		expect(buildDocumentRows(second, WORKSPACE)[0].modifiedAt).toBe(999);
	});

	it("returns the identical array for the same listing (memoized once)", () => {
		const files = [file("/ws/a.md")];
		expect(buildDocumentRows(files, WORKSPACE)).toBe(
			buildDocumentRows(files, WORKSPACE),
		);
	});
});

describe("applyDocumentTableView sorting", () => {
	beforeEach(() => {
		resetDocumentRowsMemo();
	});

	it("defaults to modified, newest first", () => {
		expect(
			pathsFor([
				file("/ws/old.md", 10),
				file("/ws/new.md", 30),
				file("/ws/mid.md", 20),
			]),
		).toEqual(["/ws/new.md", "/ws/mid.md", "/ws/old.md"]);
	});

	it("breaks equal modified timestamps by path ascending, deterministically", () => {
		const shuffled = [
			file("/ws/z.md", 42),
			file("/ws/a.md", 42),
			file("/ws/m.md", 42),
		];
		const expected = ["/ws/a.md", "/ws/m.md", "/ws/z.md"];

		expect(pathsFor(shuffled)).toEqual(expected);
		// A watcher event re-runs the same projection: the order must not jitter.
		resetDocumentRowsMemo();
		expect(pathsFor([...shuffled].reverse())).toEqual(expected);
	});

	it("sorts by name in both directions with a path tie-break", () => {
		const files = [file("/ws/b.md"), file("/ws/a.md"), file("/ws/c.md")];

		expect(
			pathsFor(files, viewWith({ sort: { column: "name", direction: "asc" } })),
		).toEqual(["/ws/a.md", "/ws/b.md", "/ws/c.md"]);
		resetDocumentRowsMemo();
		expect(
			pathsFor(
				files,
				viewWith({ sort: { column: "name", direction: "desc" } }),
			),
		).toEqual(["/ws/c.md", "/ws/b.md", "/ws/a.md"]);
	});

	it("sorts by folder label, root-level documents first", () => {
		expect(
			pathsFor(
				[file("/ws/zed/deep.md"), file("/ws/top.md"), file("/ws/alpha/one.md")],
				viewWith({ sort: { column: "folder", direction: "asc" } }),
			),
		).toEqual(["/ws/top.md", "/ws/alpha/one.md", "/ws/zed/deep.md"]);
	});

	it("returns a 5000-entry fixture in one synchronous call", () => {
		const files = Array.from({ length: 5000 }, (_, index) =>
			file(`/ws/note-${String(index).padStart(4, "0")}.md`, index),
		);

		const rows = applyDocumentTableView(
			buildDocumentRows(files, WORKSPACE),
			createDefaultDocumentTableView(),
		);

		expect(rows).toHaveLength(5000);
		expect(rows[0].path).toBe("/ws/note-4999.md");
	});
});

describe("applyDocumentTableView filtering", () => {
	beforeEach(() => {
		resetDocumentRowsMemo();
	});

	it("matches the document name case-insensitively", () => {
		expect(
			pathsFor(
				[file("/ws/release-notes.md"), file("/ws/other.md")],
				viewWith({ filter: "REL" }),
			),
		).toEqual(["/ws/release-notes.md"]);
	});

	it("never matches on the folder path", () => {
		expect(
			pathsFor(
				[file("/ws/release/other.md"), file("/ws/keep-release.md")],
				viewWith({ filter: "release" }),
			),
		).toEqual(["/ws/keep-release.md"]);
	});

	it("produces different lists for different views from one call signature", () => {
		const files = [
			file("/ws/spec-a.md", 1),
			file("/ws/spec-b.md", 3),
			file("/ws/other.md", 2),
		];
		const rows = buildDocumentRows(files, WORKSPACE);

		expect(
			applyDocumentTableView(rows, {
				filter: "spec",
				sort: { column: "name", direction: "asc" },
			}).map((row) => row.path),
		).toEqual(["/ws/spec-a.md", "/ws/spec-b.md"]);
		expect(
			applyDocumentTableView(rows, createDefaultDocumentTableView()).map(
				(row) => row.path,
			),
		).toEqual(["/ws/spec-b.md", "/ws/other.md", "/ws/spec-a.md"]);
	});

	// H3 — one app, one matcher. Every case below already worked in the command
	// palette (`lib/fileSearch.ts`, which runs the same `normalizeSearchText`),
	// so a raw `includes` here meant two search boxes that disagreed about the
	// same workspace.
	describe("agrees with the command palette's matcher", () => {
		it("matches across a separator the user typed as a space", () => {
			expect(
				pathsFor(
					[file("/ws/My-Project.md")],
					viewWith({ filter: "my project" }),
				),
			).toEqual(["/ws/My-Project.md"]);
		});

		it("matches a separator-and-case mismatch at once", () => {
			expect(
				pathsFor(
					[file("/ws/My-Project.md")],
					viewWith({ filter: "MY PROJECT" }),
				),
			).toEqual(["/ws/My-Project.md"]);
		});

		it("matches an underscored query against a spaced file name", () => {
			expect(
				pathsFor(
					[file("/ws/Meeting notes.md")],
					viewWith({ filter: "meeting_notes" }),
				),
			).toEqual(["/ws/Meeting notes.md"]);
		});

		// The extension is part of the name the user sees in Finder and in the
		// palette, so typing it is a narrowing intent, not a typo.
		it("matches a file name the user typed with its extension", () => {
			expect(
				pathsFor([file("/ws/readme.md")], viewWith({ filter: "readme.md" })),
			).toEqual(["/ws/readme.md"]);
		});
	});
});

describe("applyDocumentTableView active row (R6)", () => {
	beforeEach(() => {
		resetDocumentRowsMemo();
	});

	const files = [file("/ws/alpha.md", 2), file("/ws/beta.md", 1)];

	it("flags the open document as the active row", () => {
		const rows = applyDocumentTableView(
			buildDocumentRows(files, WORKSPACE),
			createDefaultDocumentTableView(),
			"/ws/alpha.md",
		);

		expect(rows.find((row) => row.isActive)?.path).toBe("/ws/alpha.md");
		expect(rows.every((row) => !row.isPinnedOffFilter)).toBe(true);
	});

	it("pins an open document the filter would hide", () => {
		const rows = applyDocumentTableView(
			buildDocumentRows(files, WORKSPACE),
			viewWith({ filter: "beta" }),
			"/ws/alpha.md",
		);

		expect(rows.map((row) => row.path)).toEqual([
			"/ws/alpha.md",
			"/ws/beta.md",
		]);
		expect(rows[0]).toMatchObject({ isActive: true, isPinnedOffFilter: true });
	});

	it("pins nothing when there is no open document", () => {
		expect(pathsFor(files, viewWith({ filter: "beta" }), null)).toEqual([
			"/ws/beta.md",
		]);
	});

	it("selects nothing for a document the table excludes (HTML app)", () => {
		const rows = applyDocumentTableView(
			buildDocumentRows([...files, file("/ws/app.html")], WORKSPACE),
			createDefaultDocumentTableView(),
			"/ws/app.html",
		);

		expect(rows.some((row) => row.path === "/ws/app.html")).toBe(false);
		expect(rows.some((row) => row.isActive)).toBe(false);
	});

	it("selects nothing for a document outside the workspace", () => {
		const rows = applyDocumentTableView(
			buildDocumentRows(files, WORKSPACE),
			createDefaultDocumentTableView(),
			"/elsewhere/outside.md",
		);

		expect(rows).toHaveLength(2);
		expect(rows.some((row) => row.isActive)).toBe(false);
	});

	it("matches a symlink row by its canonical open path", () => {
		const rows = applyDocumentTableView(
			buildDocumentRows(
				[
					file("/ws/link.md", 1, {
						is_symlink: true,
						symlink_target_exists: true,
						symlink_canonical_path: "/ws/target.md",
					}),
				],
				WORKSPACE,
			),
			createDefaultDocumentTableView(),
			"/ws/target.md",
		);

		expect(rows[0].isActive).toBe(true);
	});

	// D4: a symlink and its target can both be workspace files, so the open
	// document matched two rows — both painted as selected, both announced
	// `aria-current`, and keyboard navigation landed on whichever `findIndex`
	// reached first. The row whose own path is open wins.
	it("selects exactly one row when a symlink and its target are both listed", () => {
		const rows = applyDocumentTableView(
			buildDocumentRows(
				[
					file("/ws/link.md", 1, {
						is_symlink: true,
						symlink_target_exists: true,
						symlink_canonical_path: "/ws/real.md",
					}),
					file("/ws/real.md", 2),
				],
				WORKSPACE,
			),
			createDefaultDocumentTableView(),
			"/ws/real.md",
		);

		expect(rows.filter((row) => row.isActive).map((row) => row.path)).toEqual([
			"/ws/real.md",
		]);
	});
});

describe("toggleSort", () => {
	it("flips direction when the same column is clicked again", () => {
		expect(toggleSort({ column: "name", direction: "asc" }, "name")).toEqual({
			column: "name",
			direction: "desc",
		});
		expect(toggleSort({ column: "name", direction: "desc" }, "name")).toEqual({
			column: "name",
			direction: "asc",
		});
	});

	it("starts a new text column ascending and modified descending", () => {
		const modifiedDesc = createDefaultDocumentTableView().sort;
		expect(toggleSort(modifiedDesc, "name")).toEqual({
			column: "name",
			direction: "asc",
		});
		expect(toggleSort(modifiedDesc, "folder")).toEqual({
			column: "folder",
			direction: "asc",
		});
		expect(
			toggleSort({ column: "name", direction: "asc" }, "modified"),
		).toEqual({ column: "modified", direction: "desc" });
	});
});
