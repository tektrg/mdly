import { describe, expect, it } from "vitest";
import { authedJson, fetchWithBearer, jsonBody } from "./testHelpers.js";

/**
 * Web write-back slice 4: optimistic-concurrency guard on pushFile.
 * `expectedContentHash` is the hash the author's edit is based on; a move
 * underneath it rejects with 409 + the current content (keep-both), while
 * callers without the guard (desktop sync) keep legacy last-writer-wins.
 */
describe("pushFile expectedContentHash guard (write-back conflicts)", () => {
	const workspaceId = "write-conflict-ws";

	async function push(
		path: string,
		content: string,
		contentHash: string,
		extra?: Record<string, string>,
	) {
		return authedJson<{
			ok?: boolean;
			version?: number;
			error?: string;
			code?: string;
			currentContentHash?: string;
			content?: string;
		}>("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path,
				contentHash,
				content,
				deviceId: "web-test",
				...extra,
			}),
		});
	}

	async function storedContent(path: string): Promise<string | undefined> {
		const files = await authedJson<{
			files: { path: string; content: string }[];
		}>(`/api/files?workspaceId=${workspaceId}`);
		return files.body.files.find((f) => f.path === path)?.content;
	}

	it("setup: creates the workspace and a base file", async () => {
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const base = await push("note.md", "base", "hash-base");
		expect(base.status).toBe(200);
	});

	it("a push with a matching guard succeeds", async () => {
		const result = await push("note.md", "mine", "hash-mine", {
			expectedContentHash: "hash-base",
		});
		expect(result.status).toBe(200);
		expect(result.body.ok).toBe(true);
		expect(await storedContent("note.md")).toBe("mine");
	});

	it("a push with a stale guard 409s with the current content and writes nothing", async () => {
		const result = await push("note.md", "stale-words", "hash-stale", {
			expectedContentHash: "hash-base",
		});
		expect(result.status).toBe(409);
		expect(result.body.code).toBe("WRITE_CONFLICT");
		expect(result.body.currentContentHash).toBe("hash-mine");
		expect(result.body.content).toBe("mine");
		// Loser's words must NOT be stored; winner intact.
		expect(await storedContent("note.md")).toBe("mine");
	});

	it("a push with no guard keeps legacy last-writer-wins", async () => {
		const result = await push("note.md", "unguarded", "hash-unguarded");
		expect(result.status).toBe(200);
		expect(await storedContent("note.md")).toBe("unguarded");
	});

	it("a guard against a deleted file conflicts instead of resurrecting it", async () => {
		const deleted = await authedJson("/api/files/delete", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "note.md",
				deviceId: "web-test",
			}),
		});
		expect(deleted.status).toBe(200);
		const result = await push("note.md", "resurrect", "hash-res", {
			expectedContentHash: "hash-unguarded",
		});
		expect(result.status).toBe(409);
		expect(result.body.code).toBe("WRITE_CONFLICT");
	});

	it('empty-string guard means "must not exist": absent file succeeds', async () => {
		const result = await push("fresh.md", "new", "hash-new", {
			expectedContentHash: "",
		});
		expect(result.status).toBe(200);
		expect(await storedContent("fresh.md")).toBe("new");
	});

	it("empty-string guard against a live file conflicts (simultaneous create)", async () => {
		const result = await push("fresh.md", "second", "hash-second", {
			expectedContentHash: "",
		});
		expect(result.status).toBe(409);
		expect(result.body.code).toBe("WRITE_CONFLICT");
		expect(result.body.content).toBe("new");
		expect(await storedContent("fresh.md")).toBe("new");
	});
});
