import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contentHash } from "@mdly/doc-history";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSelfWriteEchoTracker,
	getHistoryStoreForWorkspace,
	loadOrCreateActorId,
	recordDeleteHistory,
	recordExternalWriteHistory,
	recordInAppWriteHistory,
	recordRenameHistory,
	resolveHistoryWorkspaceRoot,
	toWorkspaceRelativePath,
} from "./docHistoryWiring";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-history-wiring-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("resolveHistoryWorkspaceRoot (R41)", () => {
	it("picks the closest granted ancestor root for a file's own path", () => {
		const outer = "/Users/me/workspaces";
		const inner = "/Users/me/workspaces/project-a";
		const filePath = "/Users/me/workspaces/project-a/notes/todo.md";

		expect(resolveHistoryWorkspaceRoot(filePath, [outer, inner])).toBe(inner);
	});

	it("resolves purely from the file's own path, independent of any 'current workspace' pointer (R41)", () => {
		const workspaceA = "/Users/me/workspace-a";
		const workspaceB = "/Users/me/workspace-b";
		const fileInA = "/Users/me/workspace-a/note.md";

		// Simulate a workspace-switch race: whatever "current workspace" the
		// rest of the app thinks is active right now (B) must not influence
		// which root a pending edit for A's file resolves to.
		const fabricatedCurrentWorkspace = workspaceB;
		const resolved = resolveHistoryWorkspaceRoot(fileInA, [
			workspaceA,
			workspaceB,
		]);

		expect(resolved).toBe(workspaceA);
		expect(resolved).not.toBe(fabricatedCurrentWorkspace);
	});

	it("returns null when the file is under no granted root", () => {
		expect(
			resolveHistoryWorkspaceRoot("/elsewhere/note.md", ["/Users/me/ws"]),
		).toBeNull();
	});
});

describe("toWorkspaceRelativePath", () => {
	it("computes a forward-slash-normalized relative path", () => {
		expect(
			toWorkspaceRelativePath("/ws", path.join("/ws", "notes", "a.md")),
		).toBe("notes/a.md");
	});
});

describe("createSelfWriteEchoTracker (R18, R40)", () => {
	it("recognizes a matching hash and rejects a non-matching one", () => {
		const tracker = createSelfWriteEchoTracker();
		tracker.record("/ws/a.md", "hash-1");
		expect(tracker.matches("/ws/a.md", "hash-1")).toBe(true);
		expect(tracker.matches("/ws/a.md", "hash-2")).toBe(false);
		expect(tracker.matches("/ws/unknown.md", "hash-1")).toBe(false);
	});

	it("stays bounded across 1000+ writes to many distinct paths (QA8c)", () => {
		const tracker = createSelfWriteEchoTracker(16);
		for (let i = 0; i < 1500; i++) {
			tracker.record(`/ws/note-${i}.md`, `hash-${i}`);
		}
		// Internal size isn't exposed directly; prove boundedness behaviorally:
		// only the most recently written paths are still recognized.
		expect(tracker.matches("/ws/note-1499.md", "hash-1499")).toBe(true);
		expect(tracker.matches("/ws/note-0.md", "hash-0")).toBe(false);
	});
});

describe("recordInAppWriteHistory (R14, R18, R29)", () => {
	it("records a revision and echoes the write's hash for the watcher to recognize", async () => {
		const filePath = path.join(tmpDir, "note.md");
		const echoTracker = createSelfWriteEchoTracker();

		await recordInAppWriteHistory({
			absoluteFilePath: filePath,
			content: "hello world",
			grantedRoots: [tmpDir],
			actorId: "device-1",
			historyCause: "manual",
			echoTracker,
		});

		const store = getHistoryStoreForWorkspace(tmpDir);
		const history = await store.getRevisionHistory("note.md");
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			cause: "manual",
			by: { kind: "human", id: "device-1" },
		});

		const expectedHash = await contentHash(
			new TextEncoder().encode("hello world"),
		);
		expect(echoTracker.matches(filePath, expectedHash)).toBe(true);
	});

	it("silently no-ops for a non-Markdown path: no revision, no id (R7, O7)", async () => {
		const filePath = path.join(tmpDir, "image.png");
		await recordInAppWriteHistory({
			absoluteFilePath: filePath,
			content: "not markdown",
			grantedRoots: [tmpDir],
			actorId: "device-1",
			historyCause: "manual",
			echoTracker: createSelfWriteEchoTracker(),
		});
		const historyRootEntries = await fs
			.readdir(path.join(tmpDir, ".mdly"))
			.catch(() => []);
		expect(historyRootEntries).toEqual([]);
	});

	it("never throws even if the underlying store rejects (R29 — the real save it rides alongside must still complete)", async () => {
		vi.resetModules();
		vi.doMock("@mdly/doc-history", async (importOriginal) => {
			const actual = await importOriginal<typeof import("@mdly/doc-history")>();
			return {
				...actual,
				createHistoryStore: () => ({
					historyRoot: "/unused",
					recordRevision: vi.fn().mockRejectedValue(new Error("disk full")),
					getRevisionHistory: vi.fn(),
					readRevisionContent: vi.fn(),
					resolveDocId: vi.fn(),
					renamePath: vi.fn(),
					forgetDocumentAtPath: vi.fn(),
				}),
			};
		});
		const { recordInAppWriteHistory: recordWithFailingStore } = await import(
			"./docHistoryWiring"
		);

		await expect(
			recordWithFailingStore({
				absoluteFilePath: path.join(tmpDir, "note.md"),
				content: "hello",
				grantedRoots: [tmpDir],
				actorId: "device-1",
				historyCause: "manual",
				echoTracker: createSelfWriteEchoTracker(),
			}),
		).resolves.toBeUndefined();

		vi.doUnmock("@mdly/doc-history");
		vi.resetModules();
	});
});

describe("recordExternalWriteHistory (R13, R18, R35)", () => {
	it("records an external-write revision with the file's real content", async () => {
		const filePath = path.join(tmpDir, "note.md");
		await fs.writeFile(filePath, "edited outside the app");

		await recordExternalWriteHistory({
			absoluteFilePath: filePath,
			grantedRoots: [tmpDir],
			echoTracker: createSelfWriteEchoTracker(),
		});

		const history =
			await getHistoryStoreForWorkspace(tmpDir).getRevisionHistory("note.md");
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			cause: "external-write",
			by: { kind: "external" },
		});
	});

	it("skips recording when the hash matches the app's own most recent write to that path (R18)", async () => {
		const filePath = path.join(tmpDir, "note.md");
		await fs.writeFile(filePath, "app wrote this");
		const echoTracker = createSelfWriteEchoTracker();
		const hash = await contentHash(new TextEncoder().encode("app wrote this"));
		echoTracker.record(filePath, hash);

		await recordExternalWriteHistory({
			absoluteFilePath: filePath,
			grantedRoots: [tmpDir],
			echoTracker,
		});

		const history =
			await getHistoryStoreForWorkspace(tmpDir).getRevisionHistory("note.md");
		expect(history).toEqual([]);
	});

	it("does not record a bogus revision when the transient unlink half of an atomic replace can't be read (R35)", async () => {
		const filePath = path.join(tmpDir, "note.md");
		await expect(
			recordExternalWriteHistory({
				absoluteFilePath: filePath,
				grantedRoots: [tmpDir],
				echoTracker: createSelfWriteEchoTracker(),
				readFile: async () => {
					throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				},
			}),
		).resolves.toBeUndefined();

		const history =
			await getHistoryStoreForWorkspace(tmpDir).getRevisionHistory("note.md");
		expect(history).toEqual([]);
	});

	it("silently no-ops for a non-Markdown path (R7, O7)", async () => {
		const filePath = path.join(tmpDir, "photo.png");
		await fs.writeFile(filePath, "binary-ish content");

		await recordExternalWriteHistory({
			absoluteFilePath: filePath,
			grantedRoots: [tmpDir],
			echoTracker: createSelfWriteEchoTracker(),
		});

		const historyRootEntries = await fs
			.readdir(path.join(tmpDir, ".mdly"))
			.catch(() => []);
		expect(historyRootEntries).toEqual([]);
	});
});

describe("recordRenameHistory (R11, R31)", () => {
	it("keeps the same document id/log across a rename", async () => {
		const fromPath = path.join(tmpDir, "a.md");
		const toPath = path.join(tmpDir, "b.md");
		const echoTracker = createSelfWriteEchoTracker();

		await recordInAppWriteHistory({
			absoluteFilePath: fromPath,
			content: "v1",
			grantedRoots: [tmpDir],
			actorId: "device-1",
			historyCause: "manual",
			echoTracker,
		});

		await recordRenameHistory({
			fromAbsolutePath: fromPath,
			toAbsolutePath: toPath,
			grantedRoots: [tmpDir],
		});

		await recordInAppWriteHistory({
			absoluteFilePath: toPath,
			content: "v2",
			grantedRoots: [tmpDir],
			actorId: "device-1",
			historyCause: "manual",
			echoTracker,
		});

		const store = getHistoryStoreForWorkspace(tmpDir);
		const historyAtNewPath = await store.getRevisionHistory("b.md");
		expect(historyAtNewPath.map((r) => r.cause)).toEqual(["manual", "manual"]);
		expect(await store.getRevisionHistory("a.md")).toEqual([]);
	});

	it("silently no-ops for a non-Markdown rename (R7, O7)", async () => {
		const fromPath = path.join(tmpDir, "a.png");
		const toPath = path.join(tmpDir, "b.png");
		await recordRenameHistory({
			fromAbsolutePath: fromPath,
			toAbsolutePath: toPath,
			grantedRoots: [tmpDir],
		});

		const historyRootEntries = await fs
			.readdir(path.join(tmpDir, ".mdly"))
			.catch(() => []);
		expect(historyRootEntries).toEqual([]);
	});
});

describe("desktop:delete-file wiring — recordDeleteHistory (R33)", () => {
	/**
	 * Reproduces the exact sequence the real `desktop:delete-file` IPC handler
	 * in `main.ts` runs — `fs.rm` on the real path, then `recordDeleteHistory`
	 * — against a real temp-dir filesystem (not the package's in-memory fake
	 * used by `historyStore.test.ts`'s QA1b/QA5c). This is the end-to-end proof
	 * that QA1b/QA5c's own comment says is missing: that the wiring the real
	 * handler calls, not just the store's standalone primitive, breaks the
	 * path's document-id binding on a real delete.
	 */
	async function deleteFileLikeTheRealHandler(
		absolutePath: string,
		grantedRoots: Iterable<string>,
	) {
		await fs.rm(absolutePath, { recursive: false });
		await recordDeleteHistory({ absoluteFilePath: absolutePath, grantedRoots });
	}

	it("a new unrelated file created at a reused path never inherits the deleted file's history", async () => {
		const filePath = path.join(tmpDir, "note.md");
		const echoTracker = createSelfWriteEchoTracker();

		// recordInAppWriteHistory only records history — it does not write the
		// real file (that's `desktop:write-file-text`'s own `fs.writeFile` call
		// in `main.ts`, which happens before it ever calls this). Write the real
		// bytes too so the delete below has a real file to remove, matching what
		// the real save+delete sequence looks like on disk.
		await fs.writeFile(filePath, "original content, v1");

		// The original document, tracked with history, like any in-app-saved note.
		await recordInAppWriteHistory({
			absoluteFilePath: filePath,
			content: "original content, v1",
			grantedRoots: [tmpDir],
			actorId: "device-1",
			historyCause: "manual",
			echoTracker,
		});
		await recordInAppWriteHistory({
			absoluteFilePath: filePath,
			content: "original content, v2",
			grantedRoots: [tmpDir],
			actorId: "device-1",
			historyCause: "manual",
			echoTracker,
		});
		const store = getHistoryStoreForWorkspace(tmpDir);
		const originalHistory = await store.getRevisionHistory("note.md");
		expect(originalHistory).toHaveLength(2);

		// Delete through the exact sequence the real IPC handler runs.
		await deleteFileLikeTheRealHandler(filePath, [tmpDir]);

		// A brand-new, unrelated file lands at the same path (matching
		// `createMarkdownFileInFolder`'s always-the-same-default-name behavior).
		await recordInAppWriteHistory({
			absoluteFilePath: filePath,
			content: "totally unrelated new content",
			grantedRoots: [tmpDir],
			actorId: "device-1",
			historyCause: "manual",
			echoTracker,
		});
		const newHistory = await store.getRevisionHistory("note.md");

		// A fresh id/log was minted: the new document has exactly its own one
		// revision, and none of the deleted document's revision ids appear in it.
		expect(newHistory).toHaveLength(1);
		const oldRevisionIds = new Set(originalHistory.map((rev) => rev.id));
		expect(oldRevisionIds.has(newHistory[0].id)).toBe(false);
		expect(newHistory[0].prev).toBeNull();
	});

	it("silently no-ops for a non-Markdown path (R7)", async () => {
		const filePath = path.join(tmpDir, "image.png");
		await fs.writeFile(filePath, "binary-ish");

		await deleteFileLikeTheRealHandler(filePath, [tmpDir]);

		const historyRootEntries = await fs
			.readdir(path.join(tmpDir, ".mdly"))
			.catch(() => []);
		expect(historyRootEntries).toEqual([]);
	});

	it("never throws even if the underlying store rejects, so a history-recording failure can't affect the real delete (R29-style contract)", async () => {
		vi.resetModules();
		vi.doMock("@mdly/doc-history", async (importOriginal) => {
			const actual = await importOriginal<typeof import("@mdly/doc-history")>();
			return {
				...actual,
				createHistoryStore: () => ({
					historyRoot: "/unused",
					recordRevision: vi.fn(),
					getRevisionHistory: vi.fn(),
					readRevisionContent: vi.fn(),
					resolveDocId: vi.fn(),
					renamePath: vi.fn(),
					forgetDocumentAtPath: vi
						.fn()
						.mockRejectedValue(new Error("disk full")),
				}),
			};
		});
		const { recordDeleteHistory: recordDeleteWithFailingStore } = await import(
			"./docHistoryWiring"
		);
		const filePath = path.join(tmpDir, "note.md");
		await fs.writeFile(filePath, "content");

		await fs.rm(filePath);
		await expect(
			recordDeleteWithFailingStore({
				absoluteFilePath: filePath,
				grantedRoots: [tmpDir],
			}),
		).resolves.toBeUndefined();

		vi.doUnmock("@mdly/doc-history");
		vi.resetModules();
	});
});

describe("loadOrCreateActorId", () => {
	it("mints an id once and reuses it across calls, persisted in the given directory", async () => {
		const first = await loadOrCreateActorId(tmpDir);
		const second = await loadOrCreateActorId(tmpDir);
		expect(second).toBe(first);
		const raw = await fs.readFile(path.join(tmpDir, "actor-id.json"), "utf8");
		expect(JSON.parse(raw)).toEqual({ id: first });
	});
});
