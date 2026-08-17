import { describe, expect, it } from "vitest";
import { createHistoryStore, historyRootFor } from "./historyStore.js";
import type { RevisionAuthor } from "./revisionLog.js";
import {
	createFakeCompressor,
	createMemoryFileSystem,
} from "./testing/memoryFs.js";

const HUMAN: RevisionAuthor = { kind: "human", id: "device-1" };

function makeStore(workspaceRoot = "/ws") {
	const fs = createMemoryFileSystem();
	const compressor = createFakeCompressor();
	return {
		fs,
		compressor,
		store: createHistoryStore({ fs, compressor, workspaceRoot }),
	};
}

describe("createHistoryStore — filesystem-interface portability (R21)", () => {
	it("performs a full write+read cycle against only the injected in-memory fake fs, no real disk I/O", async () => {
		const { store } = makeStore();
		const recorded = await store.recordRevision("note.md", "hello", {
			by: HUMAN,
			cause: "manual",
		});
		expect(recorded.status).toBe("recorded");

		const history = await store.getRevisionHistory("note.md");
		expect(history).toHaveLength(1);

		const content = await store.readRevisionContent("note.md", history[0].id);
		expect(content).toEqual({
			status: "ok",
			bytes: new TextEncoder().encode("hello"),
		});
	});
});

describe("createHistoryStore — fresh-workspace bootstrap (R24, QA6a)", () => {
	it("creates objects/ and log/ from scratch on a bare workspace with nothing pre-created", async () => {
		const { fs, store } = makeStore();
		expect(await fs.listDir(historyRootFor("/ws"))).toEqual([]);

		const result = await store.recordRevision("note.md", "first content", {
			by: HUMAN,
			cause: "manual",
		});

		expect(result.status).toBe("recorded");
		const rootEntries = await fs.listDir(historyRootFor("/ws"));
		expect(rootEntries).toEqual(
			expect.arrayContaining(["objects", "log", "index.jsonl"]),
		);
	});
});

describe("createHistoryStore — dedupe (R6)", () => {
	it("skips a new revision and a new blob when content is byte-identical to the current head", async () => {
		const { store } = makeStore();
		await store.recordRevision("note.md", "same content", {
			by: HUMAN,
			cause: "manual",
		});
		const second = await store.recordRevision("note.md", "same content", {
			by: HUMAN,
			cause: "manual",
		});

		expect(second).toMatchObject({ status: "skipped", reason: "duplicate" });
		expect(await store.getRevisionHistory("note.md")).toHaveLength(1);
	});

	it("still assigns a stable path/index the very first time, and the index only grows once for repeat calls", async () => {
		const { store } = makeStore();
		const first = await store.resolveDocId("note.md");
		const second = await store.resolveDocId("note.md");
		expect(first.isNew).toBe(true);
		expect(second.isNew).toBe(false);
		expect(second.id).toBe(first.id);
	});
});

describe("createHistoryStore — concurrent same-document cuts never branch (R27, QA3a)", () => {
	it("produces one straight prev-chain even without awaiting between overlapping recordRevision calls", async () => {
		const { store } = makeStore();
		const first = store.recordRevision("note.md", "version A", {
			by: HUMAN,
			cause: "idle-session",
		});
		const second = store.recordRevision("note.md", "version B", {
			by: HUMAN,
			cause: "external-write",
		});
		await Promise.all([first, second]);

		const history = await store.getRevisionHistory("note.md");
		expect(history).toHaveLength(2);
		// A straight chain: the second revision's prev is the first's id, never
		// two revisions both claiming no prev / the same prev.
		const [rev1, rev2] = history;
		expect(rev1.prev).toBeNull();
		expect(rev2.prev).toBe(rev1.id);
	});
});

describe("createHistoryStore — unregistered rename degrades safely (R42)", () => {
	it("treats a path swap with no recordRename call as first-seen, minting a fresh id with a clean log", async () => {
		const { store } = makeStore();
		const original = await store.recordRevision("a.md", "content at A", {
			by: HUMAN,
			cause: "manual",
		});
		expect(original.status).toBe("recorded");

		// No renamePath() call — a hook simply writes new content at a new path.
		const atNewPath = await store.recordRevision(
			"b.md",
			"content at B, unrelated to A",
			{
				by: HUMAN,
				cause: "manual",
			},
		);
		expect(atNewPath.status).toBe("recorded");
		if (atNewPath.status !== "recorded" || original.status !== "recorded")
			throw new Error("unreachable");
		expect(atNewPath.docId).not.toBe(original.docId);

		const historyA = await store.getRevisionHistory("a.md");
		const historyB = await store.getRevisionHistory("b.md");
		expect(historyA).toHaveLength(1);
		expect(historyB).toHaveLength(1);
	});
});

describe("createHistoryStore — deletion does not fuse onto a reused path (R33)", () => {
	it("QA1b: forgetting a path's binding before reuse mints a fresh id/log for the new content", async () => {
		const { store } = makeStore();
		const original = await store.recordRevision("note.md", "v1", {
			by: HUMAN,
			cause: "manual",
		});
		await store.recordRevision("note.md", "v2", { by: HUMAN, cause: "manual" });
		if (original.status !== "recorded") throw new Error("unreachable");

		// Simulate the deleted document's path binding being released (the real
		// `desktop:delete-file` IPC handler now calls this too, via
		// `recordDeleteHistory` in `apps/desktop/electron/docHistoryWiring.ts` —
		// see `apps/desktop/electron/main.test.ts` for that wiring proven
		// end-to-end; this test exercises the store primitive directly).
		await store.forgetDocumentAtPath("note.md");

		const brandNew = await store.recordRevision(
			"note.md",
			"totally unrelated new note",
			{
				by: HUMAN,
				cause: "manual",
			},
		);
		expect(brandNew.status).toBe("recorded");
		if (brandNew.status !== "recorded") throw new Error("unreachable");
		expect(brandNew.docId).not.toBe(original.docId);

		const newHistory = await store.getRevisionHistory("note.md");
		expect(newHistory).toHaveLength(1);
	});

	it("QA5c: the deleted document's old revisions never appear in the new document's log", async () => {
		const { store } = makeStore();
		await store.recordRevision("note.md", "old content", {
			by: HUMAN,
			cause: "manual",
		});
		await store.forgetDocumentAtPath("note.md");
		await store.recordRevision("note.md", "new unrelated content", {
			by: HUMAN,
			cause: "manual",
		});

		const history = await store.getRevisionHistory("note.md");
		expect(history).toHaveLength(1);
		const content = await store.readRevisionContent("note.md", history[0].id);
		expect(content).toEqual({
			status: "ok",
			bytes: new TextEncoder().encode("new unrelated content"),
		});
	});
});
