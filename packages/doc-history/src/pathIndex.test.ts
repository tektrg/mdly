import { describe, expect, it } from "vitest";
import { rebuildPathIndexFromLogs, resolvePathIndex } from "./pathIndex.js";
import { recordRename, resolveOrAssignDocId } from "./rename.js";
import { createMemoryFileSystem } from "./testing/memoryFs.js";

const ROOT = "/ws/.mdly/history";

describe("path↔id index (R10)", () => {
	it("survives its own loss: rebuilding from per-document logs alone reproduces the same map", async () => {
		const fs = createMemoryFileSystem();

		await resolveOrAssignDocId(fs, ROOT, "a.md");
		await resolveOrAssignDocId(fs, ROOT, "b.md");
		await recordRename(fs, ROOT, "a.md", "a-renamed.md");
		await resolveOrAssignDocId(fs, ROOT, "c.md");
		await recordRename(fs, ROOT, "a-renamed.md", "a-final.md");

		const snapshot = await resolvePathIndex(fs, ROOT);
		expect([...snapshot.keys()].sort()).toEqual(["a-final.md", "b.md", "c.md"]);

		// Simulate index loss.
		await fs.writeFile(`${ROOT}/index.jsonl`, new Uint8Array());

		const rebuilt = await rebuildPathIndexFromLogs(fs, ROOT);
		expect(rebuilt).toEqual(snapshot);
	});

	it("only ever appends to the index file — earlier bytes are an unmodified prefix after later events", async () => {
		const fs = createMemoryFileSystem();
		await resolveOrAssignDocId(fs, ROOT, "a.md");
		const before = await fs.readFile(`${ROOT}/index.jsonl`);
		await resolveOrAssignDocId(fs, ROOT, "b.md");
		const after = await fs.readFile(`${ROOT}/index.jsonl`);

		const beforeText = new TextDecoder().decode(before ?? new Uint8Array());
		const afterText = new TextDecoder().decode(after ?? new Uint8Array());
		expect(afterText.startsWith(beforeText)).toBe(true);
	});

	it("merges a forked index file (index 2.jsonl) without loss or duplication, like the revision logs", async () => {
		const fs = createMemoryFileSystem();
		await fs.writeFile(
			`${ROOT}/index.jsonl`,
			new TextEncoder().encode(
				`${JSON.stringify({ id: "e1", at: 1, event: "assign", docId: "doc-1", path: "a.md" })}\n`,
			),
		);
		await fs.writeFile(
			`${ROOT}/index 2.jsonl`,
			new TextEncoder().encode(
				`${JSON.stringify({ id: "e2", at: 2, event: "assign", docId: "doc-2", path: "b.md" })}\n`,
			),
		);

		const map = await resolvePathIndex(fs, ROOT);
		expect(map.get("a.md")).toBe("doc-1");
		expect(map.get("b.md")).toBe("doc-2");
	});
});
