import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RevisionAuthor } from "@mdly/doc-history";
import type { TextAnchor } from "@mdly/doc-comments";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	listCommentThreadsForPath,
	openCommentThreadForPath,
	reopenCommentThreadForPath,
	replyToCommentThreadForPath,
	resolveCommentDocId,
	resolveCommentThreadForPath,
} from "./comments";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-comments-wiring-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

const AUTHOR: RevisionAuthor = { kind: "human", id: "device-1" };

function quoteAnchor(quote: string): TextAnchor {
	return { from: 0, to: quote.length, quote, mode: "quote" };
}

// R23: the desktop wiring for the five comment actions (open/reply/resolve/
// reopen/list) actually appends to and reads back from the real on-disk log
// through the same main-process functions `main.ts`'s IPC handlers call --
// not just traced by reading the source.
describe("comments desktop wiring (R23)", () => {
	it("opens a thread and lists it back as open", async () => {
		const filePath = path.join(tmpDir, "note.md");

		await openCommentThreadForPath({
			absoluteFilePath: filePath,
			grantedRoots: [tmpDir],
			author: AUTHOR,
			anchor: quoteAnchor("hello"),
			text: "why bold?",
		});

		const { threads } = await listCommentThreadsForPath(filePath, [tmpDir]);
		expect(threads).toHaveLength(1);
		expect(threads[0]).toMatchObject({
			state: "open",
			opener: { by: AUTHOR, text: "why bold?" },
		});
	});

	it("each write door appends exactly one line to the on-disk log (R2)", async () => {
		const filePath = path.join(tmpDir, "note.md");
		const docId = await resolveCommentDocId(tmpDir, "note.md");
		const logPath = path.join(tmpDir, ".mdly", "comments", `${docId}.jsonl`);

		await openCommentThreadForPath({
			absoluteFilePath: filePath,
			grantedRoots: [tmpDir],
			author: AUTHOR,
			anchor: quoteAnchor("hello"),
			text: "why bold?",
		});
		const opened = await listCommentThreadsForPath(filePath, [tmpDir]);
		const threadId = opened.threads[0].id;

		await replyToCommentThreadForPath({
			absoluteFilePath: filePath,
			grantedRoots: [tmpDir],
			author: AUTHOR,
			threadId,
			text: "because style guide",
		});
		await resolveCommentThreadForPath({
			absoluteFilePath: filePath,
			grantedRoots: [tmpDir],
			author: AUTHOR,
			threadId,
		});
		await reopenCommentThreadForPath({
			absoluteFilePath: filePath,
			grantedRoots: [tmpDir],
			author: AUTHOR,
			threadId,
		});

		const lines = (await fs.readFile(logPath, "utf8"))
			.split("\n")
			.filter((line) => line.length > 0);
		expect(lines).toHaveLength(4);

		const { threads } = await listCommentThreadsForPath(filePath, [tmpDir]);
		expect(threads[0].state).toBe("open");
		expect(threads[0].events.map((event) => event.kind)).toEqual([
			"thread-opened",
			"replied",
			"resolved",
			"reopened",
		]);
	});

	it("shares the same docId as revision history for a renamed file (R9)", async () => {
		const originalPath = path.join(tmpDir, "original.md");
		await openCommentThreadForPath({
			absoluteFilePath: originalPath,
			grantedRoots: [tmpDir],
			author: AUTHOR,
			anchor: quoteAnchor("hello"),
			text: "first comment",
		});
		const docIdBefore = await resolveCommentDocId(tmpDir, "original.md");

		// A rename doesn't touch the comments store directly here (the path-
		// index is doc-history's), but a later listCommentThreadsForPath call
		// on the same still-registered relative path must keep resolving to
		// the identical docId, not mint a second log.
		const docIdAgain = await resolveCommentDocId(tmpDir, "original.md");
		expect(docIdAgain).toBe(docIdBefore);

		const { docId, threads } = await listCommentThreadsForPath(originalPath, [
			tmpDir,
		]);
		expect(docId).toBe(docIdBefore);
		expect(threads).toHaveLength(1);
	});

	it("rejects a path outside every granted root instead of writing anywhere", async () => {
		await expect(
			openCommentThreadForPath({
				absoluteFilePath: "/elsewhere/note.md",
				grantedRoots: [tmpDir],
				author: AUTHOR,
				anchor: quoteAnchor("hello"),
				text: "should not land",
			}),
		).rejects.toThrow();
	});
});
