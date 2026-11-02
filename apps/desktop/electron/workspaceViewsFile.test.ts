import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyViewsFile, type ViewsFile } from "@tektrg/table-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createWorkspaceViewStore,
	viewsFilePath,
} from "./workspaceViewsFile";

let ws: string;
beforeEach(async () => {
	ws = await fs.mkdtemp(path.join(os.tmpdir(), "mdly-views-"));
});
afterEach(async () => {
	await fs.chmod(path.join(ws, ".hubble"), 0o755).catch(() => {});
	await fs.rm(ws, { recursive: true, force: true });
});

const file = (...names: string[]): ViewsFile => ({
	...emptyViewsFile(),
	views: names.map((name) => ({ id: `id-${name}`, name })),
});

const onDisk = () => fs.readFile(viewsFilePath(ws), "utf8");
const writeRaw = async (text: string) => {
	await fs.mkdir(path.join(ws, ".hubble"), { recursive: true });
	await fs.writeFile(viewsFilePath(ws), text);
};

describe("workspace views file adapter (R11, R13, R18, R21)", () => {
	it("missing file reads as missing and creates nothing", async () => {
		const store = createWorkspaceViewStore(ws);
		expect(await store.read()).toEqual({ status: "missing" });
		expect(await fs.readdir(ws)).toEqual([]);
	});

	it("first write creates .hubble/ and stable pretty JSON with version + newline", async () => {
		const store = createWorkspaceViewStore(ws);
		const result = await store.write(file("A"), null);
		expect(result.status).toBe("ok");
		const text = await onDisk();
		expect(text.endsWith("\n")).toBe(true);
		expect(JSON.parse(text)).toEqual({
			version: 1,
			views: [{ id: "id-A", name: "A" }],
		});
		expect(await fs.readdir(path.join(ws, ".hubble"))).toEqual(["views.json"]);
		// Same input → identical bytes.
		const read = await store.read();
		if (read.status !== "ok") throw new Error(read.status);
		await store.write(file("A"), read.snapshot);
		expect(await onDisk()).toBe(text);
	});

	it("round-trips: read returns the written views with the write's snapshot", async () => {
		const store = createWorkspaceViewStore(ws);
		const written = await store.write(file("A", "B"), null);
		const read = await store.read();
		expect(read.status).toBe("ok");
		if (read.status !== "ok" || written.status !== "ok") return;
		expect(read.file.views.map((v) => v.name)).toEqual(["A", "B"]);
		expect(read.snapshot).toBe(written.snapshot);
	});

	it("each workspace has its own file", async () => {
		const other = await fs.mkdtemp(path.join(os.tmpdir(), "mdly-views-b-"));
		try {
			await createWorkspaceViewStore(ws).write(file("A"), null);
			expect(await createWorkspaceViewStore(other).read()).toEqual({
				status: "missing",
			});
		} finally {
			await fs.rm(other, { recursive: true, force: true });
		}
	});

	it("invalid JSON reads as corrupt, is never overwritten by write", async () => {
		await writeRaw("{bad");
		const store = createWorkspaceViewStore(ws);
		const read = await store.read();
		expect(read.status).toBe("corrupt");
		const result = await store.write(
			file("A"),
			read.status === "corrupt" ? read.snapshot : null,
		);
		expect(result.status).toBe("conflict");
		expect(await onDisk()).toBe("{bad");
	});

	it("empty file / {} / wrong version count as corrupt", async () => {
		const store = createWorkspaceViewStore(ws);
		for (const text of ["", "{}", '{"version":9,"views":[]}', "[]"]) {
			await writeRaw(text);
			expect((await store.read()).status).toBe("corrupt");
		}
	});

	it("invalid UTF-8 reads as corrupt", async () => {
		await fs.mkdir(path.join(ws, ".hubble"));
		await fs.writeFile(viewsFilePath(ws), Buffer.from([0xff, 0xfe, 0x7b]));
		expect((await createWorkspaceViewStore(ws).read()).status).toBe("corrupt");
	});

	it("a views.json that is a directory reads as unreadable, never empty", async () => {
		await fs.mkdir(viewsFilePath(ws), { recursive: true });
		const store = createWorkspaceViewStore(ws);
		expect((await store.read()).status).toBe("unreadable");
		expect((await store.write(file("A"), null)).status).not.toBe("ok");
	});

	it("bad entries are skipped with a warning and preserved on save (R14)", async () => {
		await writeRaw(
			`${JSON.stringify({ version: 1, views: [{ id: "x", name: "X", extra: 1 }, { nope: true }], future: "keep" })}\n`,
		);
		const store = createWorkspaceViewStore(ws);
		const read = await store.read();
		if (read.status !== "ok") throw new Error(read.status);
		expect(read.file.views.map((v) => v.id)).toEqual(["x"]);
		expect(read.warnings.length).toBe(1);
		await store.write(read.file, read.snapshot);
		const saved = JSON.parse(await onDisk());
		expect(saved.future).toBe("keep");
		expect(saved.views).toEqual([{ extra: 1, id: "x", name: "X" }, { nope: true }]);
	});

	it("refuses (conflict) when the file changed since it was read; newer content survives", async () => {
		const store = createWorkspaceViewStore(ws);
		const first = await store.write(file("A"), null);
		if (first.status !== "ok") throw new Error(first.status);
		await writeRaw(`${JSON.stringify({ version: 1, views: [{ id: "o", name: "Other Mac" }] })}\n`);
		expect((await store.write(file("Mine"), first.snapshot)).status).toBe(
			"conflict",
		);
		expect(await onDisk()).toContain("Other Mac");
	});

	it("expected null refuses when a file appeared meanwhile", async () => {
		await writeRaw(`${JSON.stringify({ version: 1, views: [] })}\n`);
		const store = createWorkspaceViewStore(ws);
		expect((await store.write(file("A"), null)).status).toBe("conflict");
	});

	it("a deleted file with a non-null snapshot is a conflict, not a silent recreate", async () => {
		const store = createWorkspaceViewStore(ws);
		const first = await store.write(file("A"), null);
		if (first.status !== "ok") throw new Error(first.status);
		await fs.rm(viewsFilePath(ws));
		expect((await store.write(file("B"), first.snapshot)).status).toBe(
			"conflict",
		);
	});

	it("is atomic: a failure before rename leaves the old file intact and no temp file", async () => {
		const store = createWorkspaceViewStore(ws, {
			beforeRename: async () => {
				throw new Error("boom");
			},
		});
		const plain = createWorkspaceViewStore(ws);
		const first = await plain.write(file("A"), null);
		if (first.status !== "ok") throw new Error(first.status);
		const before = await onDisk();
		const result = await store.write(file("B"), first.snapshot);
		expect(result.status).toBe("error");
		expect(await onDisk()).toBe(before);
		expect(await fs.readdir(path.join(ws, ".hubble"))).toEqual(["views.json"]);
	});

	it("a read-only .hubble folder reports an error, not ok (R19)", async () => {
		if (process.getuid?.() === 0) return;
		const store = createWorkspaceViewStore(ws);
		const first = await store.write(file("A"), null);
		if (first.status !== "ok") throw new Error(first.status);
		await fs.chmod(path.join(ws, ".hubble"), 0o555);
		const result = await store.write(file("B"), first.snapshot);
		expect(result.status).toBe("error");
	});

	it("resetCorrupt backs up to a unique views.json.corrupt-<ts> then writes fresh; twice keeps both", async () => {
		const store = createWorkspaceViewStore(ws);
		await writeRaw("{bad one");
		const first = await store.resetCorrupt?.(file("A"));
		expect(first?.status).toBe("ok");
		await writeRaw("{bad two");
		const second = await store.resetCorrupt?.(file("B"));
		expect(second?.status).toBe("ok");
		const names = (await fs.readdir(path.join(ws, ".hubble"))).sort();
		const backups = names.filter((n) => n.startsWith("views.json.corrupt-"));
		expect(backups).toHaveLength(2);
		const contents = await Promise.all(
			backups.map((n) => fs.readFile(path.join(ws, ".hubble", n), "utf8")),
		);
		expect(contents.sort()).toEqual(["{bad one", "{bad two"]);
		expect(JSON.parse(await onDisk()).views[0].name).toBe("B");
	});

	it("resetCorrupt refuses to replace a healthy file", async () => {
		const store = createWorkspaceViewStore(ws);
		await store.write(file("A"), null);
		expect((await store.resetCorrupt?.(file("B")))?.status).toBe("conflict");
		expect(JSON.parse(await onDisk()).views[0].name).toBe("A");
	});
});
