import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAgentThread,
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
});

describe("AGENT_TOOL_DESCRIPTORS annotations", () => {
	it("has at least the two read-only tools", () => {
		const readOnly = AGENT_TOOL_DESCRIPTORS.filter(
			(descriptor) => descriptor.annotations.readOnlyHint,
		);
		expect(readOnly.map((descriptor) => descriptor.name).sort()).toEqual([
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
});
