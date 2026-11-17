import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendHookEvent, type HookEvent, newHookEvent } from "./events.js";
import {
	ensureWorkspace,
	readOpenDocs,
	resolveDocStore,
	subscriberCovers,
	watchScope,
	writeOpenDocs,
} from "./scope.js";
import { listLiveSubscribers, registerSubscriber } from "./subscribers.js";

let tmp: string;
let appData: string;
let ws: string;
let loose: string;
beforeEach(async () => {
	tmp = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "agent-hook-scope-")),
	);
	appData = path.join(tmp, "appdata");
	ws = path.join(tmp, "ws");
	loose = path.join(tmp, "loose");
	await fs.mkdir(path.join(ws, ".mdly"), { recursive: true });
	await fs.mkdir(path.join(ws, "sub"), { recursive: true });
	await fs.mkdir(loose, { recursive: true });
	await fs.mkdir(appData, { recursive: true });
});
afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

/** Appends a user comment on `absPath`, wherever its store lives. */
async function comment(absPath: string, text: string) {
	const store = resolveDocStore(absPath, appData);
	await appendHookEvent(
		store.workspaceRoot,
		newHookEvent("comment.added", store.doc, "user", { text }),
	);
}

async function collect(
	scope: Parameters<typeof watchScope>[0]["scope"],
	act: () => Promise<void>,
) {
	const seen: { text: unknown; path: string; event: HookEvent }[] = [];
	const controller = new AbortController();
	let ready: () => void = () => {};
	const isReady = new Promise<void>((r) => {
		ready = r;
	});
	const done = watchScope({
		onReady: () => ready(),
		appDataDir: appData,
		scope,
		intervalMs: 5,
		signal: controller.signal,
		onEvent: (event, absPath) =>
			seen.push({ text: event.text, path: absPath, event }),
	});
	await isReady;
	await act();
	await new Promise((r) => setTimeout(r, 60));
	controller.abort();
	await done;
	return seen;
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe("resolveDocStore", () => {
	it("uses the nearest .mdly workspace, else a standalone store in app data", () => {
		const inWs = resolveDocStore(path.join(ws, "sub", "a.md"), appData);
		expect(inWs).toMatchObject({
			workspaceRoot: ws,
			doc: path.join("sub", "a.md"),
			path: path.join(ws, "sub", "a.md"),
		});
		const standalone = resolveDocStore(path.join(loose, "b.md"), appData);
		expect(standalone.workspaceRoot.startsWith(appData)).toBe(true);
		expect(standalone.doc).toBe(path.join(loose, "b.md"));
		expect(standalone.path).toBe(path.join(loose, "b.md"));
	});
});

describe("watchScope", () => {
	it("file scope: a standalone file outside any workspace", async () => {
		const file = path.join(loose, "b.md");
		const seen = await collect({ kind: "file", path: file }, async () => {
			await comment(file, "hi");
			await comment(path.join(loose, "other.md"), "not me");
		});
		expect(seen.map((s) => [s.text, s.path])).toEqual([["hi", file]]);
	});

	it("workspace scope: every doc in it, including streams that start later", async () => {
		const a = path.join(ws, "a.md");
		const b = path.join(ws, "sub", "b.md");
		await comment(a, "before start");
		const seen = await collect({ kind: "workspace", root: ws }, async () => {
			await comment(a, "a1");
			await tick();
			await comment(b, "b1");
			await comment(path.join(loose, "x.md"), "outside");
		});
		expect(seen.map((s) => [s.text, s.path])).toEqual([
			["a1", a],
			["b1", b],
		]);
		// Each line names its doc.
		expect(seen[1].event.doc).toBe(path.join("sub", "b.md"));
	});

	it("workspace scope on a subfolder of a workspace: its docs only, no nested store", async () => {
		const sub = path.join(ws, "sub");
		const inSub = path.join(sub, "b.md");
		const seen = await collect({ kind: "workspace", root: sub }, async () => {
			await ensureWorkspace(sub);
			await comment(inSub, "b1");
			await comment(path.join(ws, "a.md"), "outside the subfolder");
		});
		expect(seen.map((s) => [s.text, s.path])).toEqual([["b1", inSub]]);
		// The doc's stream stays in the enclosing workspace (pending proposals stay visible).
		expect(resolveDocStore(inSub, appData).workspaceRoot).toBe(ws);
	});

	it("open scope: follows docs as they open and close", async () => {
		const a = path.join(ws, "a.md");
		const b = path.join(loose, "b.md");
		await writeOpenDocs(appData, [a]);
		const seen = await collect({ kind: "open" }, async () => {
			await comment(a, "a open");
			await comment(b, "b closed");
			await tick();
			await writeOpenDocs(appData, [b]);
			await tick();
			await comment(a, "a closed");
			await comment(b, "b open");
		});
		expect(seen.map((s) => s.text)).toEqual(["a open", "b open"]);
	});

	it("open docs from a dead app count as none", async () => {
		await writeOpenDocs(appData, [path.join(ws, "a.md")], 999_999_999);
		expect(await readOpenDocs(appData)).toEqual([]);
	});
});

describe("subscriber scope", () => {
	it("a subscriber covers the docs of its scope (badge on every doc in scope)", async () => {
		const a = path.join(ws, "a.md");
		const b = path.join(loose, "b.md");
		await registerSubscriber(appData, {
			scope: { kind: "workspace", root: ws },
			name: "W",
			machine: "m",
		});
		await registerSubscriber(appData, {
			scope: { kind: "file", path: b },
			name: "F",
			machine: "m",
		});
		await registerSubscriber(appData, {
			scope: { kind: "open" },
			name: "O",
			machine: "m",
		});
		const subs = await listLiveSubscribers(appData);
		const names = (doc: string, open: string[]) =>
			subs
				.filter((s) => subscriberCovers(s, doc, open))
				.map((s) => s.name)
				.sort();
		expect(names(a, [])).toEqual(["W"]);
		expect(names(b, [b])).toEqual(["F", "O"]);
		expect(names(path.join(tmp, "elsewhere.md"), [])).toEqual([]);
	});
});
