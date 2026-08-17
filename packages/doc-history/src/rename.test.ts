import { describe, expect, it } from "vitest";
import { rebuildPathIndexFromLogs, resolvePathIndex } from "./pathIndex.js";
import { recordRename, resolveOrAssignDocId } from "./rename.js";
import {
	appendLogEntry,
	logFilePath,
	readRevisionHistory,
} from "./revisionLog.js";
import { createMemoryFileSystem } from "./testing/memoryFs.js";

const ROOT = "/ws/.mdly/history";

describe("resolveOrAssignDocId (R8, R9)", () => {
	it("mints an id once, keyed by id, and stays put on later calls for the same path", async () => {
		const fs = createMemoryFileSystem();
		const first = await resolveOrAssignDocId(fs, ROOT, "/ws/a.md");
		const second = await resolveOrAssignDocId(fs, ROOT, "/ws/a.md");

		expect(first.isNew).toBe(true);
		expect(second.isNew).toBe(false);
		expect(second.id).toBe(first.id);
		expect(logFilePath(ROOT, first.id)).toBe(`${ROOT}/log/${first.id}.jsonl`);
	});
});

describe("recordRename (R11)", () => {
	it("keeps full history under the same id and the same log file across a rename", async () => {
		const fs = createMemoryFileSystem();
		const { id } = await resolveOrAssignDocId(fs, ROOT, "/ws/a.md");
		await appendLogEntry(fs, ROOT, id, {
			entryKind: "revision",
			id: "rev1",
			hash: "hash1",
			at: 1,
			by: { kind: "human", id: "me" },
			cause: "manual",
			bytes: 5,
			prev: null,
		});

		const rename = await recordRename(fs, ROOT, "/ws/a.md", "/ws/b.md");
		expect(rename.id).toBe(id);

		await appendLogEntry(fs, ROOT, id, {
			entryKind: "revision",
			id: "rev2",
			hash: "hash2",
			at: 2,
			by: { kind: "human", id: "me" },
			cause: "manual",
			bytes: 6,
			prev: "rev1",
		});

		const resolvedAfterRename = await resolveOrAssignDocId(
			fs,
			ROOT,
			"/ws/b.md",
		);
		expect(resolvedAfterRename.id).toBe(id);
		expect(resolvedAfterRename.isNew).toBe(false);

		const history = await readRevisionHistory(fs, ROOT, id);
		expect(history.map((r) => r.id)).toEqual(["rev1", "rev2"]);

		// Rebuilding the path index from the per-document logs alone reproduces
		// the same mapping, even after a rename.
		const rebuilt = await rebuildPathIndexFromLogs(fs, ROOT);
		expect(rebuilt.get("/ws/b.md")).toBe(id);
		expect(rebuilt.has("/ws/a.md")).toBe(false);
	});

	it("never forks the log — both pre- and post-rename revisions live in one single log file", async () => {
		const fs = createMemoryFileSystem();
		const { id } = await resolveOrAssignDocId(fs, ROOT, "a.md");
		await appendLogEntry(fs, ROOT, id, {
			entryKind: "revision",
			id: "rev1",
			hash: "hash1",
			at: 1,
			by: { kind: "human", id: "me" },
			cause: "manual",
			bytes: 5,
			prev: null,
		});
		await recordRename(fs, ROOT, "a.md", "b.md");
		await appendLogEntry(fs, ROOT, id, {
			entryKind: "revision",
			id: "rev2",
			hash: "hash2",
			at: 2,
			by: { kind: "human", id: "me" },
			cause: "manual",
			bytes: 6,
			prev: "rev1",
		});

		const logDirEntries = await fs.listDir(`${ROOT}/log`);
		const logFilesForDoc = logDirEntries.filter((name) => name.startsWith(id));
		expect(logFilesForDoc).toEqual([`${id}.jsonl`]);
	});
});

describe("path↔id index resolves like the real desktop:rename-file mechanics (R31)", () => {
	it("resolves the renamed path to the same id used before the rename, matching a from→to rename call", async () => {
		const fs = createMemoryFileSystem();
		const { id } = await resolveOrAssignDocId(fs, ROOT, "notes/draft.md");
		await recordRename(fs, ROOT, "notes/draft.md", "notes/final.md");

		const map = await resolvePathIndex(fs, ROOT);
		expect(map.get("notes/final.md")).toBe(id);
		expect(map.has("notes/draft.md")).toBe(false);
	});
});
