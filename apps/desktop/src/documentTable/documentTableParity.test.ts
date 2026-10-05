/**
 * Parity: the table-core-backed filter + sort vs a FROZEN copy of the
 * pre-engine logic (2026-10-05), on random file sets.
 *
 * Names use letters (any case, é/É), digits, space, "-" and ".", where ICU and
 * the engine's caseless order agree. Known, accepted differences are pinned
 * separately below: names starting with punctuation such as "_" or "@" now sort
 * after digits, and the filter also ignores accents.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { FileEntry } from "../store/state";
import { evaluateDocumentRowsForTest } from "./documentTableEngine";
import {
	applyDocumentTableView,
	buildDocumentRows,
	createDefaultDocumentTableView,
	type DocumentTableColumn,
	type DocumentTableRow,
	type DocumentTableView,
	resetDocumentRowsMemo,
} from "./documentTableView";

// ---- frozen legacy logic (do not edit) ------------------------------------
/** The pre-engine `normalizeSearchText` (no accent folding). */
function normalizeSearchText(value: string): string {
	return value.toLocaleLowerCase().replace(/[\s_\-./\\]+/g, "");
}

function legacyCompare(
	a: DocumentTableRow,
	b: DocumentTableRow,
	column: DocumentTableColumn,
): number {
	switch (column) {
		case "name":
			return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
		case "folder":
			return a.folderLabel.localeCompare(b.folderLabel, undefined, {
				sensitivity: "base",
			});
		case "modified":
			return a.modifiedAt - b.modifiedAt;
		case "created":
			return a.createdAt - b.createdAt;
	}
}

function legacyFilterAndSort(
	rows: DocumentTableRow[],
	view: DocumentTableView,
): string[] {
	const direction = view.sort.direction === "desc" ? -1 : 1;
	const needle = normalizeSearchText(view.filter);
	return rows
		.filter(
			(row) =>
				needle.length === 0 ||
				normalizeSearchText(row.path.split("/").pop() ?? "").includes(needle),
		)
		.sort(
			(a, b) =>
				legacyCompare(a, b, view.sort.column) * direction ||
				(a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
		)
		.map((row) => row.path);
}
// ---------------------------------------------------------------------------

function seededRandom(seed: number) {
	let state = seed;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state / 2_147_483_648;
	};
}

const NAME_CHARS = [..."aAbBcCeEéÉzZ019 -."];
const FOLDERS = ["", "a", "B", "notes", "Notes", "notes/deep", "z 1", "é"];
const EXTENSIONS = [".md", ".markdown", ".MD"];

function randomFiles(random: () => number, count: number): FileEntry[] {
	const pick = <T>(list: readonly T[]) =>
		list[Math.floor(random() * list.length)];
	const files = new Map<string, FileEntry>();
	for (let index = 0; index < count; index += 1) {
		const length = 1 + Math.floor(random() * 6);
		let name = "";
		for (let char = 0; char < length; char += 1) name += pick(NAME_CHARS);
		// Leading separators are the accepted-difference zone; keep a letter first.
		name = `${pick([..."aBé9"])}${name}`;
		const folder = pick(FOLDERS);
		const path = `/ws/${folder ? `${folder}/` : ""}${name}${pick(EXTENSIONS)}`;
		files.set(path, {
			path,
			// Few distinct times, so ties (and the path tie-break) are common.
			modified_at: 100 + Math.floor(random() * 5),
			created_at: random() < 0.3 ? undefined : 50 + Math.floor(random() * 5),
		});
	}
	return [...files.values()];
}

const COLUMNS: DocumentTableColumn[] = [
	"name",
	"folder",
	"modified",
	"created",
];
// No query may contain "e": "é" names would match it only through the new accent folding.
const QUERIES = [
	"",
	" ",
	"a",
	"A",
	"b.md",
	"c",
	"C",
	"zz9",
	"-",
	"9",
	"a b",
	"zz",
];

describe("document table on table-core: parity with the pre-engine logic", () => {
	beforeEach(() => {
		resetDocumentRowsMemo();
	});

	it("filters and sorts identically on 200 random file sets", () => {
		const random = seededRandom(20261005);
		for (let round = 0; round < 200; round += 1) {
			resetDocumentRowsMemo();
			const rows = buildDocumentRows(randomFiles(random, 40), "/ws");
			for (const column of COLUMNS) {
				for (const direction of ["asc", "desc"] as const) {
					const query = QUERIES[round % QUERIES.length];
					const view = {
						...createDefaultDocumentTableView(),
						filter: query,
						sort: { column, direction },
					};
					const expected = legacyFilterAndSort(rows, view);
					expect(
						applyDocumentTableView(rows, view).map((row) => row.path),
					).toEqual(expected);
					// The keystroke fast path equals one plain engine evaluate().
					expect(
						evaluateDocumentRowsForTest(rows, view).map((row) => row.path),
					).toEqual(expected);
				}
			}
		}
	});

	it("accepted difference: a name starting with punctuation sorts after digits", () => {
		const rows = buildDocumentRows(
			[
				{ path: "/ws/_draft.md", modified_at: 1 },
				{ path: "/ws/2024.md", modified_at: 1 },
				{ path: "/ws/alpha.md", modified_at: 1 },
			],
			"/ws",
		);
		const view = {
			...createDefaultDocumentTableView(),
			sort: { column: "name" as const, direction: "asc" as const },
		};
		// Was _draft, 2024, alpha (ICU puts "_" before digits).
		expect(applyDocumentTableView(rows, view).map((row) => row.name)).toEqual([
			"2024",
			"_draft",
			"alpha",
		]);
	});

	it("new: the filter also ignores accents (cafe finds Café)", () => {
		const rows = buildDocumentRows(
			[{ path: "/ws/Café notes.md", modified_at: 1 }],
			"/ws",
		);
		const view = { ...createDefaultDocumentTableView(), filter: "cafe" };
		expect(applyDocumentTableView(rows, view)).toHaveLength(1);
	});
});
