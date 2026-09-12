import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAgentThread,
	listAgentDocuments,
	listAgentThreads,
	reopenAgentThread,
	replyToAgentThread,
	resolveAgentThread,
} from "./agentComments";
import type { AgentToolContext } from "./agentToolContract";
import { AGENT_TOOL_DESCRIPTORS, AGENT_TOOLS } from "./agentTools";
import { resolveCommentDocId } from "./comments";
import { getHistoryStoreForWorkspace } from "./docHistoryWiring";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-comments-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeNote(
	relativePath: string,
	content: string,
): Promise<string> {
	const absolutePath = path.join(tmpDir, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content, "utf8");
	return absolutePath;
}

function makeCtx(
	openDocumentPath: string | null,
	notified: string[],
): AgentToolContext {
	return {
		grantedRoots: [tmpDir],
		actorId: "agent-device-1",
		openDocumentPath,
		notifyCommentsChanged: (absolutePath: string) =>
			notified.push(absolutePath),
	};
}

async function commentLogLineCount(relativePath: string): Promise<number> {
	const docId = await resolveCommentDocId(tmpDir, relativePath);
	const logPath = path.join(tmpDir, ".mdly", "comments", `${docId}.jsonl`);
	try {
		const content = await fs.readFile(logPath, "utf8");
		return content.split("\n").filter((line) => line.length > 0).length;
	} catch {
		return 0;
	}
}

async function commentLogPath(relativePath: string): Promise<string> {
	const docId = await resolveCommentDocId(tmpDir, relativePath);
	return path.join(tmpDir, ".mdly", "comments", `${docId}.jsonl`);
}

/** Sets a note's comment-log mtime deliberately, so `list_documents`'s recency ranking has something controllable to sort by. */
async function touchCommentLog(
	relativePath: string,
	timeMs: number,
): Promise<void> {
	const logPath = await commentLogPath(relativePath);
	const when = new Date(timeMs);
	await fs.utimes(logPath, when, when);
}

// R23-style desktop wiring proof for Slice 4: every behaviour is exercised
// against a real temp directory and the real on-disk `.jsonl` log — never a
// mock of `@mdly/doc-comments`.
describe("agentComments", () => {
	it("rejects reply/resolve/reopen on a nonexistent threadId and writes nothing (E)", async () => {
		const relativePath = "note.md";
		const absolutePath = await writeNote(
			relativePath,
			"Hello world, this is a note about foxes.\n",
		);
		const notified: string[] = [];
		const ctx = makeCtx(absolutePath, notified);

		await createAgentThread(
			{ path: relativePath, quote: "Hello world", text: "hi" },
			ctx,
		);
		expect(await commentLogLineCount(relativePath)).toBe(1);

		await expect(
			replyToAgentThread(
				{ path: relativePath, threadId: "made-up-id", text: "reply" },
				ctx,
			),
		).rejects.toThrow(/made-up-id/);
		await expect(
			resolveAgentThread({ path: relativePath, threadId: "made-up-id" }, ctx),
		).rejects.toThrow(/made-up-id/);
		await expect(
			reopenAgentThread({ path: relativePath, threadId: "made-up-id" }, ctx),
		).rejects.toThrow(/made-up-id/);

		expect(await commentLogLineCount(relativePath)).toBe(1);
		// Only the original create notified — none of the three rejected writes did.
		expect(notified).toEqual([absolutePath]);
	});

	it("rejects create_thread when the quote appears twice, and writes nothing", async () => {
		const relativePath = "note.md";
		await writeNote(relativePath, "foo bar foo baz\n");
		const notified: string[] = [];
		const ctx = makeCtx(null, notified);

		await expect(
			createAgentThread(
				{ path: relativePath, quote: "foo", text: "which one?" },
				ctx,
			),
		).rejects.toThrow(/ambiguous/i);

		expect(await commentLogLineCount(relativePath)).toBe(0);
		expect(notified).toEqual([]);
	});

	it("rejects create_thread when the quote appears zero times, and writes nothing", async () => {
		const relativePath = "note.md";
		await writeNote(relativePath, "Nothing interesting here.\n");
		const notified: string[] = [];
		const ctx = makeCtx(null, notified);

		await expect(
			createAgentThread(
				{
					path: relativePath,
					quote: "a phrase that is not present",
					text: "??",
				},
				ctx,
			),
		).rejects.toThrow(/not found/i);

		expect(await commentLogLineCount(relativePath)).toBe(0);
		expect(notified).toEqual([]);
	});

	it("create_thread with a unique quote writes exactly one line, authored by the agent (F, G)", async () => {
		const relativePath = "note.md";
		const absolutePath = await writeNote(
			relativePath,
			"# Title\n\nThe quick brown fox jumps over the lazy dog.\n",
		);
		const notified: string[] = [];
		const ctx = makeCtx(absolutePath, notified);

		await createAgentThread(
			{ path: relativePath, quote: "quick brown fox", text: "nice line" },
			ctx,
		);

		expect(await commentLogLineCount(relativePath)).toBe(1);
		expect(notified).toEqual([absolutePath]); // G: notified with the absolute path

		const { documents } = await listAgentThreads(
			{ scope: "open", state: "all", path: relativePath },
			ctx,
		);
		expect(documents).toHaveLength(1);
		expect(documents[0].threads).toHaveLength(1);
		const thread = documents[0].threads[0];
		expect(thread.openedBy).toMatchObject({ kind: "agent", label: "AI agent" });
		expect(thread.quote).toBe("quick brown fox");
		// The quote is still present in the saved body, so re-resolving against
		// it (rather than trusting the always-empty text `comments.ts` itself
		// passes to `listThreads`) finds it via quote+context fallback.
		expect(thread.anchorStatus).toBe("fallback-anchored");
		expect(thread.messages).toEqual([
			{
				author: { kind: "agent", id: "agent-device-1", label: "AI agent" },
				kind: "thread-opened",
				text: "nice line",
			},
		]);
	});

	it("lists threads across the whole workspace, finds a thread on a document that isn't open, and skips a docId whose note was deleted (B)", async () => {
		const openPath = "open.md";
		const openAbsolute = await writeNote(
			openPath,
			"The open note has no comments.\n",
		);

		const otherPath = "notes/other.md";
		await writeNote(otherPath, "A different note with a highlighted phrase.\n");

		const deletedPath = "gone.md";
		const deletedAbsolute = await writeNote(
			deletedPath,
			"This note will be deleted.\n",
		);

		const notified: string[] = [];
		const ctx = makeCtx(openAbsolute, notified);

		await createAgentThread(
			{ path: otherPath, quote: "highlighted phrase", text: "why highlight?" },
			ctx,
		);
		await createAgentThread(
			{ path: deletedPath, quote: "will be deleted", text: "stray comment" },
			ctx,
		);

		// Simulate a real delete: remove the file AND release its path-index
		// binding, mirroring `recordDeleteHistory` in docHistoryWiring.ts (R33).
		// The comment log is left behind on disk with no current path.
		await fs.rm(deletedAbsolute);
		await getHistoryStoreForWorkspace(tmpDir).forgetDocumentAtPath(deletedPath);

		const { openDocument, documents } = await listAgentThreads(
			{ scope: "workspace", state: "all" },
			ctx,
		);

		expect(openDocument).toEqual({
			path: openAbsolute,
			relativePath: openPath,
		});
		const paths = documents.map((document) => document.path);
		expect(paths).toContain(otherPath);
		expect(paths).not.toContain(deletedPath);
		expect(paths).not.toContain(openPath); // open note has zero threads -> filtered out
	});

	it("rejects a path outside every granted root without writing (A)", async () => {
		const notified: string[] = [];
		const ctx = makeCtx(null, notified);

		await expect(
			createAgentThread(
				{ path: "/definitely/outside/note.md", quote: "x", text: "y" },
				ctx,
			),
		).rejects.toThrow(/granted/i);

		expect(notified).toEqual([]);
		const mdlyDirExists = await fs
			.access(path.join(tmpDir, ".mdly"))
			.then(() => true)
			.catch(() => false);
		expect(mdlyDirExists).toBe(false);
	});

	it("errorResult from the tool wrapper, never a thrown exception, on a bogus thread id", async () => {
		const relativePath = "note.md";
		const absolutePath = await writeNote(
			relativePath,
			"Some words to comment on.\n",
		);
		const notified: string[] = [];
		const ctx = makeCtx(absolutePath, notified);
		const replyToolDescriptor = AGENT_TOOLS.find(
			(tool) => tool.name === "reply",
		);
		if (!replyToolDescriptor) throw new Error("reply tool not registered");

		const result = await replyToolDescriptor.execute(
			{ path: relativePath, thread_id: "bogus", text: "hi" },
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(await commentLogLineCount(relativePath)).toBe(0);
	});

	it("list_threads with no scope now returns ONLY the open document; scope: workspace still returns the whole workspace", async () => {
		const openPath = "open.md";
		const openAbsolute = await writeNote(
			openPath,
			"The open note has a distinct phrase.\n",
		);
		const otherPath = "other.md";
		await writeNote(
			otherPath,
			"A different note has a distinct phrase as well.\n",
		);

		const notified: string[] = [];
		const ctx = makeCtx(openAbsolute, notified);

		await createAgentThread(
			{ path: openPath, quote: "distinct phrase", text: "on the open note" },
			ctx,
		);
		await createAgentThread(
			{
				path: otherPath,
				quote: "distinct phrase as well",
				text: "on the other note",
			},
			ctx,
		);

		// FALSIFICATION: against the old default (`scope ?? "workspace"`), this
		// assertion fails — it would see both documents, not just the open one.
		const defaultScoped = await listAgentThreads({ state: "all" }, ctx);
		expect(defaultScoped.documents.map((document) => document.path)).toEqual([
			openPath,
		]);

		const wholeWorkspace = await listAgentThreads(
			{ state: "all", scope: "workspace" },
			ctx,
		);
		const paths = wholeWorkspace.documents.map((document) => document.path);
		expect(paths).toContain(openPath);
		expect(paths).toContain(otherPath);
	});
});

describe("listAgentDocuments", () => {
	it("ranks by comment-log recency, newest first", async () => {
		const aPath = "a.md";
		const bPath = "b.md";
		const cPath = "c.md";
		await writeNote(aPath, "Alpha note with a findable phrase.\n");
		await writeNote(bPath, "Bravo note with another findable phrase.\n");
		await writeNote(cPath, "Charlie note with yet another findable phrase.\n");

		const notified: string[] = [];
		const ctx = makeCtx(null, notified);
		await createAgentThread(
			{ path: aPath, quote: "findable phrase", text: "on a" },
			ctx,
		);
		await createAgentThread(
			{ path: bPath, quote: "another findable phrase", text: "on b" },
			ctx,
		);
		await createAgentThread(
			{ path: cPath, quote: "yet another findable phrase", text: "on c" },
			ctx,
		);

		// Deliberately out of creation order: c newest, then a, then b oldest.
		const now = Date.now();
		await touchCommentLog(cPath, now);
		await touchCommentLog(aPath, now - 60_000);
		await touchCommentLog(bPath, now - 120_000);

		const { documents } = await listAgentDocuments({ state: "all" }, ctx);
		expect(documents.map((document) => document.relativePath)).toEqual([
			cPath,
			aPath,
			bPath,
		]);
	});

	it("honours `limit` and reports `truncated: true` when candidates remain", async () => {
		const notified: string[] = [];
		const ctx = makeCtx(null, notified);
		for (let i = 0; i < 5; i++) {
			const relativePath = `note-${i}.md`;
			await writeNote(relativePath, `Note number ${i} has a unique phrase.\n`);
			await createAgentThread(
				{ path: relativePath, quote: "unique phrase", text: `comment ${i}` },
				ctx,
			);
		}

		const { documents, truncated } = await listAgentDocuments(
			{ state: "all", limit: 2 },
			ctx,
		);
		expect(documents).toHaveLength(2);
		expect(truncated).toBe(true);
	});

	it("skips a document whose note was deleted (log present, no current path)", async () => {
		const keptPath = "kept.md";
		await writeNote(keptPath, "This note stays and has a unique phrase.\n");
		const deletedPath = "gone.md";
		const deletedAbsolute = await writeNote(
			deletedPath,
			"This note will be deleted, also unique.\n",
		);

		const notified: string[] = [];
		const ctx = makeCtx(null, notified);
		await createAgentThread(
			{ path: keptPath, quote: "unique phrase", text: "still here" },
			ctx,
		);
		await createAgentThread(
			{ path: deletedPath, quote: "also unique", text: "stray comment" },
			ctx,
		);

		await fs.rm(deletedAbsolute);
		await getHistoryStoreForWorkspace(tmpDir).forgetDocumentAtPath(deletedPath);

		const { documents } = await listAgentDocuments({ state: "all" }, ctx);
		const paths = documents.map((document) => document.relativePath);
		expect(paths).toContain(keptPath);
		expect(paths).not.toContain(deletedPath);
	});

	it("excludes a document whose only thread is resolved under state: open, includes it under state: all", async () => {
		const relativePath = "note.md";
		await writeNote(relativePath, "A note with a resolvable phrase.\n");
		const notified: string[] = [];
		const ctx = makeCtx(null, notified);
		await createAgentThread(
			{ path: relativePath, quote: "resolvable phrase", text: "please look" },
			ctx,
		);

		const { documents: beforeResolve } = await listAgentThreads(
			{ scope: "open", state: "all", path: relativePath },
			ctx,
		);
		const threadId = beforeResolve[0].threads[0].threadId;
		await resolveAgentThread({ path: relativePath, threadId }, ctx);

		const openOnly = await listAgentDocuments({ state: "open" }, ctx);
		expect(
			openOnly.documents.map((document) => document.relativePath),
		).not.toContain(relativePath);

		const all = await listAgentDocuments({ state: "all" }, ctx);
		expect(all.documents.map((document) => document.relativePath)).toContain(
			relativePath,
		);
	});

	it("reports isOpenDocument true for ctx.openDocumentPath and false otherwise", async () => {
		const openPath = "open.md";
		const openAbsolute = await writeNote(
			openPath,
			"The open note has a locatable phrase.\n",
		);
		const otherPath = "other.md";
		await writeNote(
			otherPath,
			"The other note has a different locatable phrase.\n",
		);

		const notified: string[] = [];
		const ctx = makeCtx(openAbsolute, notified);
		await createAgentThread(
			{ path: openPath, quote: "locatable phrase", text: "on open" },
			ctx,
		);
		await createAgentThread(
			{
				path: otherPath,
				quote: "different locatable phrase",
				text: "on other",
			},
			ctx,
		);

		const { documents } = await listAgentDocuments({ state: "all" }, ctx);
		const openDoc = documents.find(
			(document) => document.relativePath === openPath,
		);
		const otherDoc = documents.find(
			(document) => document.relativePath === otherPath,
		);
		expect(openDoc?.isOpenDocument).toBe(true);
		expect(otherDoc?.isOpenDocument).toBe(false);
	});

	it("counts openThreads and resolvedThreads correctly on a document holding one of each", async () => {
		const relativePath = "note.md";
		await writeNote(
			relativePath,
			"This note has a first phrase and a second phrase.\n",
		);
		const notified: string[] = [];
		const ctx = makeCtx(null, notified);
		await createAgentThread(
			{ path: relativePath, quote: "first phrase", text: "comment one" },
			ctx,
		);
		await createAgentThread(
			{ path: relativePath, quote: "second phrase", text: "comment two" },
			ctx,
		);

		const { documents: beforeResolve } = await listAgentThreads(
			{ scope: "open", state: "all", path: relativePath },
			ctx,
		);
		const firstThreadId = beforeResolve[0].threads[0].threadId;
		await resolveAgentThread(
			{ path: relativePath, threadId: firstThreadId },
			ctx,
		);

		const { documents } = await listAgentDocuments({ state: "all" }, ctx);
		const doc = documents.find(
			(document) => document.relativePath === relativePath,
		);
		expect(doc?.openThreads).toBe(1);
		expect(doc?.resolvedThreads).toBe(1);
	});

	it("works with NO open document and NO path (the core requirement)", async () => {
		const relativePath = "note.md";
		await writeNote(relativePath, "A note with a standalone phrase.\n");
		const notified: string[] = [];
		const ctx = makeCtx(null, notified);
		await createAgentThread(
			{ path: relativePath, quote: "standalone phrase", text: "hello" },
			ctx,
		);

		const result = await listAgentDocuments({}, ctx);
		expect(result.openDocument).toBeNull();
		expect(result.documents.map((document) => document.relativePath)).toContain(
			relativePath,
		);
	});

	it("skips a corrupt (unreadable) comment log without failing the whole listing", async () => {
		const brokenPath = "broken.md";
		await writeNote(brokenPath, "A note whose log will be made unreadable.\n");
		const okPath = "ok.md";
		await writeNote(okPath, "A note whose log stays readable.\n");

		const notified: string[] = [];
		const ctx = makeCtx(null, notified);
		await createAgentThread(
			{ path: brokenPath, quote: "made unreadable", text: "on broken" },
			ctx,
		);
		await createAgentThread(
			{ path: okPath, quote: "stays readable", text: "on ok" },
			ctx,
		);

		const brokenLogPath = await commentLogPath(brokenPath);
		await fs.chmod(brokenLogPath, 0o000);

		// Running as root (or on a filesystem ignoring modes) defeats the setup,
		// not the code under test — skip the assertion rather than assert
		// something false, mirroring `agentEndToEnd.test.ts`'s own guard.
		let permissionsHold = true;
		try {
			await fs.readFile(brokenLogPath, "utf8");
			permissionsHold = false;
		} catch {
			/* expected: unreadable */
		}

		try {
			if (permissionsHold) {
				const { documents } = await listAgentDocuments({ state: "all" }, ctx);
				const paths = documents.map((document) => document.relativePath);
				expect(paths).toContain(okPath);
				expect(paths).not.toContain(brokenPath);
			}
		} finally {
			await fs.chmod(brokenLogPath, 0o644);
		}
	});
});

describe("AGENT_TOOL_DESCRIPTORS annotations", () => {
	it("has at least the three read-only tools", () => {
		const readOnly = AGENT_TOOL_DESCRIPTORS.filter(
			(descriptor) => descriptor.annotations.readOnlyHint,
		);
		expect(readOnly.map((descriptor) => descriptor.name).sort()).toEqual([
			"list_documents",
			"list_threads",
			"read_thread",
		]);
	});

	it.each(
		AGENT_TOOL_DESCRIPTORS,
	)("$name carries untrustedContentHint whenever it is read-only, so a future read tool can't skip it", (descriptor) => {
		if (descriptor.annotations.readOnlyHint) {
			expect(descriptor.annotations.untrustedContentHint).toBe(true);
		}
	});

	it("exposes no delete tool to agents -- thread deletion stays human-only", () => {
		const names = AGENT_TOOLS.map((tool) => tool.name);
		expect(names).not.toContain("delete");
		expect(names).not.toContain("delete_thread");
		expect(
			AGENT_TOOL_DESCRIPTORS.some((descriptor) =>
				descriptor.name.includes("delete"),
			),
		).toBe(false);
	});
});
