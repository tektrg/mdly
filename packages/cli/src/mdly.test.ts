import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	appendHookEvent,
	listLiveSubscribers,
	newHookEvent,
} from "@mdly/agent-hook";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMcpEndpoint, relayMcpMessage } from "./mdly.js";

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

describe("mdly watch (process)", () => {
	it("streams one JSON line per event on stdout with no TTY, and registers a subscriber", async () => {
		await fs.mkdir(path.join(root, ".mdly"));
		const doc = path.join(root, "a.md");
		await fs.writeFile(doc, "hello");
		const entry = path.resolve(__dirname, "../dist/mdly.js");
		const child = spawn(
			process.execPath,
			[entry, "watch", doc, "--name", "Claude", "--machine", "Air"],
			{
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let stdout = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		await new Promise((r) => child.stderr.once("data", r));
		const subs = await listLiveSubscribers(root, "a.md");
		expect(subs.map((s) => `${s.name}@${s.machine}`)).toEqual(["Claude@Air"]);
		// Hostile text is passed through as JSON data, never executed.
		await appendHookEvent(
			root,
			newHookEvent("comment.added", "a.md", "user", {
				text: "$(echo INJECTED)",
			}),
		);
		await new Promise((r) => setTimeout(r, 900));
		child.kill("SIGTERM");
		await new Promise((r) => child.once("exit", r));
		const lines = stdout.trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).text).toBe("$(echo INJECTED)");
		expect(stdout).not.toMatch(/(^|[^(]echo )INJECTED/);
		expect(await listLiveSubscribers(root, "a.md")).toEqual([]);
	}, 10_000);
});
