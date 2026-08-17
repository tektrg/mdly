import { describe, expect, it } from "vitest";
import {
	appendLogEntry,
	logFilePath,
	type Revision,
	readMergedLogEntries,
	readRevisionHistory,
} from "./revisionLog.js";
import { createMemoryFileSystem } from "./testing/memoryFs.js";

const ROOT = "/ws/.mdly/history";

function revisionLine(overrides: Partial<Revision> & { id: string }) {
	return {
		entryKind: "revision" as const,
		hash: "hash",
		at: Date.now(),
		by: { kind: "human" as const, id: "actor-1" },
		cause: "manual" as const,
		bytes: 10,
		prev: null,
		...overrides,
	};
}

describe("per-document append-only JSONL log (R2)", () => {
	it("keeps one log file per document; older lines are never touched by a later append", async () => {
		const fs = createMemoryFileSystem();
		await appendLogEntry(
			fs,
			ROOT,
			"doc-a",
			revisionLine({ id: "a1", prev: null }),
		);
		await appendLogEntry(
			fs,
			ROOT,
			"doc-a",
			revisionLine({ id: "a2", prev: "a1" }),
		);
		await appendLogEntry(
			fs,
			ROOT,
			"doc-b",
			revisionLine({ id: "b1", prev: null }),
		);

		const before = await fs.readFile(logFilePath(ROOT, "doc-a"));
		await appendLogEntry(
			fs,
			ROOT,
			"doc-a",
			revisionLine({ id: "a3", prev: "a2" }),
		);
		const after = await fs.readFile(logFilePath(ROOT, "doc-a"));

		expect(
			(await readRevisionHistory(fs, ROOT, "doc-a")).map((r) => r.id),
		).toEqual(["a1", "a2", "a3"]);
		expect(
			(await readRevisionHistory(fs, ROOT, "doc-b")).map((r) => r.id),
		).toEqual(["b1"]);
		// The bytes already on disk before the 4th append are an unmodified prefix of the file after.
		expect(
			after &&
				before &&
				new TextDecoder()
					.decode(after)
					.startsWith(new TextDecoder().decode(before)),
		).toBe(true);
	});
});

describe("revision record shape and prev-chain order (R3, R4)", () => {
	it("carries all 7 required fields with allowed values, and orders by prev even when clocks disagree", async () => {
		const fs = createMemoryFileSystem();
		const rev1 = revisionLine({
			id: "r1",
			at: 3000,
			prev: null,
			cause: "manual",
		});
		// Revision 2's clock is deliberately earlier than revision 1's.
		const rev2 = revisionLine({
			id: "r2",
			at: 1000,
			prev: "r1",
			cause: "idle-session",
		});
		const rev3 = revisionLine({
			id: "r3",
			at: 2000,
			prev: "r2",
			cause: "external-write",
		});
		await appendLogEntry(fs, ROOT, "doc", rev1);
		await appendLogEntry(fs, ROOT, "doc", rev2);
		await appendLogEntry(fs, ROOT, "doc", rev3);

		const history = await readRevisionHistory(fs, ROOT, "doc");
		expect(history.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);

		for (const revision of history) {
			expect(typeof revision.id).toBe("string");
			expect(typeof revision.hash).toBe("string");
			expect(typeof revision.at).toBe("number");
			expect(["human", "agent", "external"]).toContain(revision.by.kind);
			expect([
				"external-write",
				"idle-session",
				"manual",
				"import",
				"restore",
			]).toContain(revision.cause);
			expect(typeof revision.bytes).toBe("number");
			expect(revision.prev === null || typeof revision.prev === "string").toBe(
				true,
			);
		}
	});

	it("never reorders by timestamp even when later-appended entries claim earlier `at` values (QA... clock skew)", async () => {
		const fs = createMemoryFileSystem();
		await appendLogEntry(
			fs,
			ROOT,
			"doc",
			revisionLine({ id: "r1", at: 500, prev: null }),
		);
		await appendLogEntry(
			fs,
			ROOT,
			"doc",
			revisionLine({ id: "r2", at: 100, prev: "r1" }),
		);
		await appendLogEntry(
			fs,
			ROOT,
			"doc",
			revisionLine({ id: "r3", at: 50, prev: "r2" }),
		);

		const history = await readRevisionHistory(fs, ROOT, "doc");
		expect(history.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
	});

	it("gives a brand-new document's first revision an explicit null prev, terminating cleanly (R26, QA4a)", async () => {
		const fs = createMemoryFileSystem();
		await appendLogEntry(
			fs,
			ROOT,
			"solo-doc",
			revisionLine({ id: "only", prev: null }),
		);

		const history = await readRevisionHistory(fs, ROOT, "solo-doc");
		expect(history).toHaveLength(1);
		expect(history[0].prev).toBeNull();
	});
});

describe("fork-tolerant merge (R5)", () => {
	it("merges a cloud-sync-forked log (log 2.jsonl) without loss or duplication", async () => {
		const fs = createMemoryFileSystem();
		const r1 = revisionLine({ id: "r1", prev: null });
		const r2 = revisionLine({ id: "r2", prev: "r1" });
		const r3 = revisionLine({ id: "r3", prev: "r2" });

		// Primary log has [1, 2]; a sync-forked sibling has [2, 3] (2 duplicated).
		await fs.writeFile(
			logFilePath(ROOT, "doc"),
			new TextEncoder().encode(
				`${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`,
			),
		);
		await fs.writeFile(
			`/ws/.mdly/history/log/doc 2.jsonl`,
			new TextEncoder().encode(
				`${JSON.stringify(r2)}\n${JSON.stringify(r3)}\n`,
			),
		);

		const history = await readRevisionHistory(fs, ROOT, "doc");
		expect(history.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
	});

	it("merges a second forked shape with disjoint and overlapping ids the same way (a second fork-merge case)", async () => {
		const fs = createMemoryFileSystem();
		const r1 = revisionLine({ id: "r1", prev: null, at: 1 });
		const r2 = revisionLine({ id: "r2", prev: "r1", at: 2 });
		const r3 = revisionLine({ id: "r3", prev: "r2", at: 3 });
		const r4 = revisionLine({ id: "r4", prev: "r3", at: 4 });

		await fs.writeFile(
			logFilePath(ROOT, "doc"),
			new TextEncoder().encode(
				`${[r1, r2, r3].map((r) => JSON.stringify(r)).join("\n")}\n`,
			),
		);
		await fs.writeFile(
			`/ws/.mdly/history/log/doc 3.jsonl`,
			// out-of-order relative to the true chain, with r2 duplicated
			new TextEncoder().encode(
				`${[r4, r2].map((r) => JSON.stringify(r)).join("\n")}\n`,
			),
		);

		const merged = await readMergedLogEntries(fs, ROOT, "doc");
		expect(merged).toHaveLength(4);
		const history = await readRevisionHistory(fs, ROOT, "doc");
		expect(history.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
	});
});

describe("crash tolerance (R25)", () => {
	it("keeps every valid revision when the final log line is truncated/non-JSON (QA2a)", async () => {
		const fs = createMemoryFileSystem();
		const r1 = revisionLine({ id: "r1", prev: null });
		const r2 = revisionLine({ id: "r2", prev: "r1" });
		const truncated = `{"entryKind":"revision","id":"r3","hash":"ha`; // crash mid-write, no trailing newline
		await fs.writeFile(
			logFilePath(ROOT, "doc"),
			new TextEncoder().encode(
				`${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n${truncated}`,
			),
		);

		const history = await readRevisionHistory(fs, ROOT, "doc");
		expect(history.map((r) => r.id)).toEqual(["r1", "r2"]);
	});

	it("also tolerates a malformed trailing line with no trailing newline at all (QA7b)", async () => {
		const fs = createMemoryFileSystem();
		const r1 = revisionLine({ id: "only", prev: null });
		await fs.writeFile(
			logFilePath(ROOT, "doc"),
			new TextEncoder().encode(`${JSON.stringify(r1)}\nnot json at all`),
		);

		await expect(readRevisionHistory(fs, ROOT, "doc")).resolves.toEqual([
			expect.objectContaining({ id: "only" }),
		]);
	});
});

describe("origin/generated-content signal (R19)", () => {
	it("round-trips by.kind:'agent' through a read", async () => {
		const fs = createMemoryFileSystem();
		await appendLogEntry(
			fs,
			ROOT,
			"doc",
			revisionLine({
				id: "r1",
				prev: null,
				by: { kind: "agent", id: "claude-code", label: "Claude Code" },
			}),
		);

		const [revision] = await readRevisionHistory(fs, ROOT, "doc");
		expect(revision.by).toEqual({
			kind: "agent",
			id: "claude-code",
			label: "Claude Code",
		});
	});

	it("round-trips the origin signal through an import-cause write", async () => {
		const fs = createMemoryFileSystem();
		await appendLogEntry(
			fs,
			ROOT,
			"doc",
			revisionLine({
				id: "r1",
				prev: null,
				cause: "import",
				by: { kind: "agent", id: "doc-import", label: "Imported document" },
			}),
		);

		const [revision] = await readRevisionHistory(fs, ROOT, "doc");
		expect(revision.cause).toBe("import");
		expect(revision.by.kind).toBe("agent");
	});
});

describe("an unrelated document's log stays valid under unrelated activity (QA6c)", () => {
	it("keeps single-line-per-revision JSONL after further appends", async () => {
		const fs = createMemoryFileSystem();
		await appendLogEntry(
			fs,
			ROOT,
			"doc-b",
			revisionLine({ id: "b1", prev: null }),
		);
		await appendLogEntry(
			fs,
			ROOT,
			"doc-b",
			revisionLine({ id: "b2", prev: "b1" }),
		);

		const raw = await fs.readFile(logFilePath(ROOT, "doc-b"));
		const lines = new TextDecoder()
			.decode(raw ?? new Uint8Array())
			.split("\n")
			.filter((line) => line.length > 0);
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		expect(
			(await readRevisionHistory(fs, ROOT, "doc-b")).map((r) => r.id),
		).toEqual(["b1", "b2"]);
	});
});
