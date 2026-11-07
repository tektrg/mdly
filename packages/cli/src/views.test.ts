import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
	buildSavedViewRecord,
	emptyViewsFile,
	matchesFolder,
	sanitizeSavedView,
	serializeViewsFile,
} from "@tektrg/table-core";
import { createWorkspaceViewStore } from "@tektrg/table-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatView, runViewsCli } from "./views.js";

let ws: string;
let outside: string;
const viewsJson = () => path.join(ws, ".hubble", "views.json");

beforeEach(async () => {
	ws = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "hubble-views-")),
	);
	outside = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "hubble-out-")),
	);
	await fs.mkdir(path.join(ws, "notes"));
	await fs.mkdir(path.join(ws, "docs/a"), { recursive: true });
	await fs.writeFile(path.join(ws, "docs/a/b.md"), "# b\n");
});
afterEach(async () => {
	await fs.chmod(path.join(ws, ".hubble"), 0o755).catch(() => {});
	await fs.rm(ws, { recursive: true, force: true });
	await fs.rm(outside, { recursive: true, force: true });
});

async function cli(...args: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runViewsCli(["--cwd", ws, "views", ...args], {
		stdout: (l) => out.push(l),
		stderr: (l) => err.push(l),
		cwd: os.tmpdir(),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

const readRaw = () => fs.readFile(viewsJson(), "utf8").catch(() => null);
const views = async () =>
	JSON.parse((await readRaw()) ?? "{}").views as Record<string, unknown>[];
const hubbleEntries = () =>
	fs.readdir(path.join(ws, ".hubble")).catch(() => null);

/** Runs a refused command and proves nothing on disk changed. */
async function expectRefused(args: string[], message: RegExp) {
	const before = await readRaw();
	const entries = await hubbleEntries();
	const stat = before === null ? null : await fs.stat(viewsJson());
	const result = await cli(...args);
	expect(result.code, args.join(" ")).not.toBe(0);
	expect(result.err).toMatch(message);
	expect(await readRaw()).toBe(before);
	expect(await hubbleEntries()).toEqual(entries);
	if (stat) expect((await fs.stat(viewsJson())).mtimeMs).toBe(stat.mtimeMs);
}

describe("hubble views", () => {
	it("cli-create / QA1 / QA2-b: creates .hubble/views.json with one app-readable view", async () => {
		const r = await cli(
			"create",
			"Open notes",
			"--folder",
			"notes",
			"--group-by",
			"status",
			"--filter",
			"status=open",
		);
		expect(r.code).toBe(0);
		const [view] = await views();
		expect(view).toMatchObject({
			name: "Open notes",
			groupBy: "prop:status",
			filters: [
				{ kind: "folder", path: "notes" },
				{ fieldId: "prop:status", kind: "is", value: "open" },
			],
		});
		expect(sanitizeSavedView(view)).toEqual(view);
		expect(await hubbleEntries()).toEqual(["views.json"]);
	});

	it("cli-list-json / QA1-b / EC7: list --json; empty workspace prints [] and creates nothing", async () => {
		const empty = await cli("list", "--json");
		expect(empty.code).toBe(0);
		expect(JSON.parse(empty.out)).toEqual([]);
		expect(await hubbleEntries()).toBeNull();
		await cli("create", "A");
		await cli("create", "B");
		const listed = await cli("list", "--json");
		expect(JSON.parse(listed.out).map((v: { name: string }) => v.name)).toEqual(
			["A", "B"],
		);
	});

	it("QA10-b: create --json returns the record; text list is readable", async () => {
		const created = await cli("create", "X", "--folder", "notes", "--json");
		const record = JSON.parse(created.out);
		expect(typeof record.id).toBe("string");
		expect(record.name).toBe("X");
		const text = (await cli("list")).out;
		expect(text).toContain("X");
		expect(text).toContain("notes");
		expect(text).not.toContain("[object Object]");
	});

	it("cli-rename-delete / R3-preserve-other-views / QA13: only the target changes, unknown fields kept", async () => {
		const file = {
			...emptyViewsFile(),
			views: [
				{
					...buildSavedViewRecord({ id: "a", name: "A" }),
					future: { keep: true },
				},
				buildSavedViewRecord({ id: "b", name: "B" }),
				buildSavedViewRecord({ id: "c", name: "C" }),
			],
			invalidViews: [{ broken: 1 }],
			extra: { newerAppField: "x" },
		};
		await fs.mkdir(path.join(ws, ".hubble"));
		await fs.writeFile(viewsJson(), serializeViewsFile(file as never));
		const original = await views();
		expect((await cli("rename", "b", "Bee")).code).toBe(0);
		const after = await views();
		expect(after[0]).toEqual(original[0]);
		expect(after[2]).toEqual(original[2]);
		expect(after[1]).toEqual({ ...original[1], name: "Bee" });
		expect(after[3]).toEqual({ broken: 1 }); // invalid entries kept, written after the views
		expect(JSON.parse((await readRaw()) as string).newerAppField).toBe("x");
		expect((await cli("create", "D")).code).toBe(0);
		expect(JSON.parse((await readRaw()) as string).newerAppField).toBe("x");
		expect((await cli("delete", "Bee")).code).toBe(0);
		const remaining = await views();
		expect(remaining.map((v) => v.id)).toEqual([
			"a",
			"c",
			expect.any(String),
			undefined,
		]);
		expect(remaining[3]).toEqual({ broken: 1 });
	});

	it("rename keeps id and settings; delete leaves an empty list", async () => {
		await cli("create", "A", "--folder", "notes");
		const [before] = await views();
		await cli("rename", "A", "B");
		const [after] = await views();
		expect(after).toEqual({ ...before, name: "B" });
		await cli("delete", "B");
		expect(await views()).toEqual([]);
	});

	it("cli-validation / EC1 / EC2 / R6 / QA8 / QA11-b: bad input refused, nothing written", async () => {
		await expectRefused(
			["create", "X", "--folder", "nope"],
			/folder not found/,
		);
		await expectRefused(["create", "  "], /empty/);
		await cli("create", "Reading list");
		await expectRefused(["create", " reading list "], /already exists/);
		await expectRefused(["create", "READING LIST"], /already exists/);
		await expectRefused(["create", "all documents"], /built-in/);
		await expectRefused(["create", "x".repeat(61)], /longer than 60/);
		await cli("create", "Other");
		await expectRefused(["rename", "Other", "reading list"], /already exists/);
		expect((await cli("rename", "Other", "OTHER")).code).toBe(0);
		expect((await cli("create", "Café notes")).code).toBe(0);
		expect((await views()).map((v) => v.name)).toContain("Café notes");
	});

	it("EC7 / QA7: malformed filters, unknown target and bad usage refused", async () => {
		await cli("create", "A");
		await expectRefused(
			["create", "X", "--filter", "=v"],
			/empty property name/,
		);
		await expectRefused(["create", "X", "--filter", "k="], /empty value/);
		await expectRefused(["create", "X", "--group-by", "file:nope"], /group-by/);
		await expectRefused(["rename", "missing", "Y"], /no saved view/);
		await expectRefused(["delete", "missing"], /no saved view/);
		await expectRefused(["list", "--folder", "notes"], /only apply/);
		await expectRefused(["create"], /takes 1 argument/);
		const kept = await cli(
			"create",
			"Eq",
			"--filter",
			"k=a=b",
			"--filter",
			"tags",
		);
		expect(kept.code).toBe(0);
		expect((await views()).at(-1)?.filters).toEqual([
			{ fieldId: "prop:k", kind: "is", value: "a=b" },
			{ fieldId: "prop:tags", kind: "has" },
		]);
	});

	it("QA9-b / R17: unknown or missing subcommand prints usage, non-zero", async () => {
		for (const args of [["bogus"], []]) {
			const r = await cli(...args);
			expect(r.code).toBe(1);
			expect(r.err).toMatch(/list\|create\|rename\|delete|views list/);
		}
	});

	it("QA9: ambiguous target refused, bytes unchanged", async () => {
		const file = {
			...emptyViewsFile(),
			views: [
				{ id: "1", name: "Same" },
				{ id: "2", name: "same" },
			],
		};
		await fs.mkdir(path.join(ws, ".hubble"));
		await fs.writeFile(viewsJson(), serializeViewsFile(file));
		await expectRefused(["delete", "Same"], /use the view id/);
	});

	it("atomic-corrupt / EC3 / R4: corrupt file backed up, fresh file with one view, warning names the backup", async () => {
		await fs.mkdir(path.join(ws, ".hubble"));
		await fs.writeFile(viewsJson(), "not json{");
		const r = await cli("create", "Fresh");
		expect(r.code).toBe(0);
		const backup = (await hubbleEntries())?.find((n) =>
			n.startsWith("views.json.corrupt-"),
		);
		expect(backup).toBeTruthy();
		expect(r.err).toContain(path.join(ws, ".hubble", backup as string));
		expect(
			await fs.readFile(path.join(ws, ".hubble", backup as string), "utf8"),
		).toBe("not json{");
		expect((await views()).map((v) => v.name)).toEqual(["Fresh"]);
		expect((await hubbleEntries())?.some((n) => n.includes("tmp"))).toBe(false);
	});

	it("QA3 / QA4: invalid input on a corrupt file makes no backup; list is read-only", async () => {
		await fs.mkdir(path.join(ws, ".hubble"));
		await fs.writeFile(viewsJson(), "not json{");
		await expectRefused(["create", "recent"], /built-in/);
		await expectRefused(["list"], /corrupt/);
	});

	it("QA14: a leftover temp file from a crash does not block a write", async () => {
		await fs.mkdir(path.join(ws, ".hubble"));
		await fs.writeFile(
			path.join(ws, ".hubble", ".views.json.dead00.mdly-tmp"),
			"half",
		);
		expect((await cli("create", "A")).code).toBe(0);
	});

	it("QA2: read-only .hubble folder fails with a readable error, nothing changes", async () => {
		await cli("create", "A");
		await fs.chmod(path.join(ws, ".hubble"), 0o555);
		await expectRefused(["create", "B"], /cannot write/);
	});

	it("QA5 / QA5-b: concurrent creates both land", async () => {
		const results = await Promise.all([cli("create", "A"), cli("create", "B")]);
		expect(results.map((r) => r.code)).toEqual([0, 0]);
		expect((await views()).map((v) => v.name).sort()).toEqual(["A", "B"]);
	});

	it("EC8 / QA6 / QA3-b / QA4-b: folder spellings normalize; subfolders match; escapes refused", async () => {
		await fs.writeFile(path.join(ws, "file.md"), "x");
		await fs.symlink(outside, path.join(ws, "link"));
		await fs.mkdir(path.join(outside, "x"));
		const r = await cli(
			"create",
			"N",
			"--folder",
			"./notes",
			"--folder",
			"notes/",
			"--folder",
			path.join(ws, "notes"),
			"--folder",
			"docs",
		);
		expect(r.code).toBe(0);
		const [view] = await views();
		expect(view.filters).toEqual([
			{ kind: "folder", path: "notes" },
			{ kind: "folder", path: "docs" },
		]);
		expect(matchesFolder("docs/a/b.md", "docs")).toBe(true);
		for (const folder of ["../outside", outside, "link", "file.md", "."]) {
			await expectRefused(["create", "Y", "--folder", folder], /folder/);
		}
		if (process.platform === "darwin") {
			expect((await cli("create", "Case", "--folder", "NOTES")).code).toBe(0);
			expect((await views()).at(-1)?.filters).toEqual([
				{ kind: "folder", path: "notes" },
			]);
		}
	});

	it("roundtrip-app-to-cli / EC5: an app-saved record (with extra fields) is listed unchanged", async () => {
		const appRecord = {
			...buildSavedViewRecord({
				id: "app-1",
				name: "From app",
				folders: ["a"],
				groupBy: "prop:status",
				filters: [{ fieldId: "prop:tag", kind: "is", value: "x" }],
				layout: { viewType: "board", boardField: "prop:status" },
			}),
			appOnlyField: { future: 1 },
		};
		const store = createWorkspaceViewStore(ws);
		await store.write({ ...emptyViewsFile(), views: [appRecord] }, null);
		const listed = JSON.parse((await cli("list", "--json")).out);
		expect(listed).toEqual([appRecord]);
	});

	it("QA3 #4: a view with an empty name lists with a placeholder", async () => {
		await fs.mkdir(path.join(ws, ".hubble"));
		await fs.writeFile(
			viewsJson(),
			JSON.stringify({ version: 1, views: [{ id: "only-id", name: "  " }] }),
		);
		const text = (await cli("list")).out;
		expect(text).toContain("(unnamed)  (id: only-id)");
	});

	it("QA3 #4: formatView never prints 'undefined' for a record lacking name or id", () => {
		const lines = formatView({} as never).join("\n");
		expect(lines).not.toContain("undefined");
		expect(lines).toContain("(unnamed)  (id: (no id))");
	});

	it("--workspace works like --cwd; both together refused", async () => {
		const out: string[] = [];
		const code = await runViewsCli(
			["views", "--workspace", ws, "create", "W"],
			{
				stdout: (l) => out.push(l),
				stderr: () => {},
				cwd: os.tmpdir(),
			},
		);
		expect(code).toBe(0);
		expect((await views()).map((v) => v.name)).toEqual(["W"]);
		const both = await runViewsCli(
			["--cwd", ws, "views", "--workspace", ws, "list"],
			{
				stdout: () => {},
				stderr: () => {},
				cwd: ws,
			},
		);
		expect(both).toBe(1);
	});

	it("hostile names are stored as data, never run (sentinel)", async () => {
		const name = "$(echo INJECTED)";
		expect((await cli("create", name)).code).toBe(0);
		expect((await views())[0].name).toBe(name);
		const listed = (await cli("list")).out;
		expect(listed).toContain("$(echo INJECTED)");
	});

	it("R7-existing-cli-commands / R17: built bin --help lists views and cloud", async () => {
		const bin = path.join(import.meta.dirname, "..", "dist", "index.js");
		const exists = await fs.stat(bin).then(
			() => true,
			() => false,
		);
		if (!exists) return;
		const { stdout } = await promisify(execFile)(process.execPath, [
			bin,
			"--help",
		]);
		expect(stdout).toContain("views");
		expect(stdout).toContain("cloud");
	});
});
