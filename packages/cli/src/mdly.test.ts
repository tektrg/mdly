import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	appendHookEvent,
	listLiveSubscribers,
	newHookEvent,
	resolveDocStore,
	writeOpenDocs,
} from "@mdly/agent-hook";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMcpEndpoint, relayMcpMessage, runMdly } from "./mdly.js";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "mdly-cli-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("relayMcpMessage", () => {
	it("posts with the bearer token and returns the body", async () => {
		let seen: RequestInit | undefined;
		const fakeFetch = (async (_url: string, init: RequestInit) => {
			seen = init;
			return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
				status: 200,
			});
		}) as unknown as typeof fetch;
		const out = await relayMcpMessage(
			'{"jsonrpc":"2.0","id":1,"method":"ping"}',
			{ url: "http://x/mcp", token: "t" },
			fakeFetch,
		);
		expect(out).toContain('"id":1');
		expect((seen?.headers as Record<string, string>).authorization).toBe(
			"Bearer t",
		);
	});
	it("turns an unreachable app into a JSON-RPC error, and stays silent for notifications", async () => {
		const failing = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const out = await relayMcpMessage(
			'{"jsonrpc":"2.0","id":7,"method":"x"}',
			{ url: "u", token: "t" },
			failing,
		);
		expect(JSON.parse(out ?? "{}").error.message).toMatch(/unreachable/);
		expect(
			await relayMcpMessage(
				'{"jsonrpc":"2.0","method":"n"}',
				{ url: "u", token: "t" },
				failing,
			),
		).toBeNull();
	});
	it("reads endpoint + token, defaulting the url", async () => {
		await fs.writeFile(path.join(root, "agent-access.json"), '{"token":"abc"}');
		expect(await readMcpEndpoint(root)).toEqual({
			url: "http://127.0.0.1:7331/mcp",
			token: "abc",
		});
	});
});

const entry = path.resolve(__dirname, "../dist/mdly.js");

/** Runs `mdly watch …` with no TTY; returns its stdout once `act` is done. */
async function runWatch(args: string[], act: () => Promise<void>) {
	const child = spawn(process.execPath, [entry, "watch", ...args], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout.on("data", (d) => {
		stdout += d;
	});
	await new Promise((r) => child.stderr.once("data", r));
	await act();
	await new Promise((r) => setTimeout(r, 900));
	child.kill("SIGTERM");
	await new Promise((r) => child.once("exit", r));
	return stdout
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function comment(appData: string, absPath: string, text: string) {
	const store = resolveDocStore(absPath, appData);
	await appendHookEvent(
		store.workspaceRoot,
		newHookEvent("comment.added", store.doc, "user", { text }),
	);
}

describe("mdly watch (process)", () => {
	it("streams one JSON line per event on stdout with no TTY, and registers a subscriber", async () => {
		const appData = path.join(root, "appdata");
		await fs.mkdir(path.join(root, ".mdly"));
		const doc = path.join(root, "a.md");
		await fs.writeFile(doc, "hello");
		const lines = await runWatch(
			[doc, "--name", "Claude", "--machine", "Air", "--app-data", appData],
			async () => {
				const subs = await listLiveSubscribers(appData);
				expect(subs.map((s) => `${s.name}@${s.machine}`)).toEqual([
					"Claude@Air",
				]);
				expect(subs[0].scope).toEqual({ kind: "file", path: doc });
				// Hostile text is passed through as JSON data, never executed.
				await comment(appData, doc, "$(echo INJECTED)");
			},
		);
		expect(lines).toHaveLength(1);
		expect(lines[0].text).toBe("$(echo INJECTED)");
		expect(lines[0].path).toBe(doc);
		expect(JSON.stringify(lines)).not.toMatch(/(^|[^(]echo )INJECTED/);
		expect(await listLiveSubscribers(appData)).toEqual([]);
	}, 10_000);

	it("watches a standalone file outside any workspace", async () => {
		const appData = path.join(root, "appdata");
		const doc = path.join(root, "loose", "b.md");
		await fs.mkdir(path.dirname(doc), { recursive: true });
		await fs.writeFile(doc, "x");
		const lines = await runWatch([doc, "--app-data", appData], () =>
			comment(appData, doc, "hi"),
		);
		expect(lines.map((l) => [l.text, l.path])).toEqual([["hi", doc]]);
		// No .mdly folder dropped next to a loose file.
		await expect(fs.stat(path.join(root, "loose", ".mdly"))).rejects.toThrow();
	}, 10_000);

	it("--workspace streams every doc in the folder, each line naming its doc", async () => {
		const appData = path.join(root, "appdata");
		const ws = path.join(root, "ws");
		await fs.mkdir(ws);
		const a = path.join(ws, "a.md");
		const b = path.join(ws, "n", "b.md");
		const lines = await runWatch(
			["--workspace", ws, "--app-data", appData],
			async () => {
				await comment(appData, a, "a1");
				await comment(appData, b, "b1");
			},
		);
		expect(lines.map((l) => [l.text, l.path, l.doc])).toEqual([
			["a1", a, "a.md"],
			["b1", b, path.join("n", "b.md")],
		]);
	}, 10_000);

	it("--open follows the docs open in mdly", async () => {
		const appData = path.join(root, "appdata");
		const a = path.join(root, "a.md");
		const b = path.join(root, "b.md");
		await writeOpenDocs(appData, [a]);
		const lines = await runWatch(
			["--open", "--app-data", appData],
			async () => {
				await comment(appData, a, "a open");
				await comment(appData, b, "b closed");
			},
		);
		expect(lines.map((l) => l.text)).toEqual(["a open"]);
	}, 10_000);

	it("rejects no scope or two scopes", async () => {
		expect(await runMdly(["watch"])).toBe(2);
		expect(await runMdly(["watch", "x.md", "--open"])).toBe(2);
	});
});
