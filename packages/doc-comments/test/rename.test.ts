import { describe, it, expect, beforeEach } from "vitest";
import {
	forgetPath,
	historyRootFor,
	recordRename,
	resolveOrAssignDocId,
} from "@mdly/doc-history";
import { openThread, listThreads, type CommentStoreOptions } from "../src/commentStore.js";
import { readCommentEvents } from "../src/commentLog.js";
import type { TextAnchor } from "../src/types.js";
import { createMemoryFileSystem, type MemoryFileSystem } from "./testFs.js";

const WORKSPACE = "/ws";
const CURRENT_FLATTENED = "Hello world";
const storeOptions: CommentStoreOptions = {
	readRevisionContent: async () => null,
	flattenDocument: (doc) => doc,
};

describe("comments keyed against the real doc-history docId", () => {
	let fs: MemoryFileSystem;
	let historyRoot: string;

	beforeEach(() => {
		fs = createMemoryFileSystem();
		historyRoot = historyRootFor(WORKSPACE);
	});

	describe("R7 — resolveOrAssignDocId's path index is the source of the docId comments key on", () => {
		it("mints a docId for a never-versioned note and keys the comment log on it", async () => {
			const { id: docId, isNew } = await resolveOrAssignDocId(
				fs,
				historyRoot,
				`${WORKSPACE}/notes/a.md`,
			);
			expect(isNew).toBe(true);

			const anchor: TextAnchor = { from: 0, to: 5, quote: "Hello", mode: "quote" };
			await openThread(fs, WORKSPACE, {
				docId,
				author: { kind: "human", id: "user1" },
				anchor,
				text: "First comment",
			});

			const threads = await listThreads(fs, WORKSPACE, docId, CURRENT_FLATTENED, storeOptions);
			expect(threads.length).toBe(1);
			expect(threads[0].opener.text).toBe("First comment");
		});

		it("R8 — minting a docId writes only lifecycle assign entries, never a comment revision", async () => {
			await resolveOrAssignDocId(fs, historyRoot, `${WORKSPACE}/notes/a.md`);
			const mdPath = `${WORKSPACE}/notes/a.md`;
			expect(fs.getRaw(mdPath)).toBeNull();
		});
	});

	describe("R9 — renaming keeps every thread; deleting breaks the binding", () => {
		it("keeps threads reachable under the same docId after a rename", async () => {
			const original = `${WORKSPACE}/notes/a.md`;
			const renamed = `${WORKSPACE}/notes/b.md`;

			const { id: docId } = await resolveOrAssignDocId(fs, historyRoot, original);
			const anchor: TextAnchor = { from: 0, to: 5, quote: "Hello", mode: "quote" };
			await openThread(fs, WORKSPACE, {
				docId,
				author: { kind: "human", id: "user1" },
				anchor,
				text: "Comment before rename",
			});

			await recordRename(fs, historyRoot, original, renamed);
			const resolvedAfterRename = await resolveOrAssignDocId(fs, historyRoot, renamed);
			expect(resolvedAfterRename.id).toBe(docId);
			expect(resolvedAfterRename.isNew).toBe(false);

			const threads = await listThreads(fs, WORKSPACE, docId, CURRENT_FLATTENED, storeOptions);
			expect(threads.length).toBe(1);
			expect(threads[0].opener.text).toBe("Comment before rename");
		});

		it("mints a fresh docId with zero inherited threads for a new note at a deleted note's old path", async () => {
			const path = `${WORKSPACE}/notes/a.md`;
			const { id: originalDocId } = await resolveOrAssignDocId(fs, historyRoot, path);
			const anchor: TextAnchor = { from: 0, to: 5, quote: "Hello", mode: "quote" };
			await openThread(fs, WORKSPACE, {
				docId: originalDocId,
				author: { kind: "human", id: "user1" },
				anchor,
				text: "Comment on the deleted note",
			});

			await forgetPath(fs, historyRoot, path);

			const { id: newDocId, isNew } = await resolveOrAssignDocId(fs, historyRoot, path);
			expect(isNew).toBe(true);
			expect(newDocId).not.toBe(originalDocId);

			const newThreads = await listThreads(fs, WORKSPACE, newDocId, CURRENT_FLATTENED, storeOptions);
			expect(newThreads.length).toBe(0);

			// The old thread is untouched on disk, still readable by its old docId.
			const oldEvents = await readCommentEvents(fs, WORKSPACE, originalDocId);
			expect(oldEvents.length).toBe(1);
		});
	});
});
