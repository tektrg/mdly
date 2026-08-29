import { describe, it, expect, beforeEach } from "vitest";
import {
	appendCommentEvent,
	readCommentEvents,
	findCommentLogSiblings,
	commentLogPath,
	commentsDirPath,
} from "../src/commentLog.js";
import type { ThreadOpenedEvent, TextAnchor } from "../src/types.js";
import { createMemoryFileSystem, type MemoryFileSystem } from "./testFs.js";

const WORKSPACE = "/ws";
const DOC_ID = "d1";

const anchor: TextAnchor = { from: 5, to: 10, quote: "hello", mode: "quote" };

function openedEvent(overrides: Partial<ThreadOpenedEvent> = {}): ThreadOpenedEvent {
	return {
		id: "evt1",
		kind: "thread-opened",
		threadId: "evt1",
		prev: null,
		by: { kind: "human", id: "user1" },
		anchor,
		text: "Great comment",
		...overrides,
	};
}

describe("commentLog", () => {
	let fs: MemoryFileSystem;

	beforeEach(() => {
		fs = createMemoryFileSystem();
	});

	describe("R1 — comments live in plain workspace files", () => {
		it("creates the comment log at .mdly/comments/<docId>.jsonl", async () => {
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, openedEvent());

			const logPath = commentLogPath(WORKSPACE, DOC_ID);
			expect(logPath).toBe(`${WORKSPACE}/.mdly/comments/${DOC_ID}.jsonl`);
			const raw = fs.getRaw(logPath);
			expect(raw).not.toBeNull();
			const parsed = JSON.parse(new TextDecoder().decode(raw!).trim());
			expect(parsed.id).toBe("evt1");
			expect(parsed.kind).toBe("thread-opened");
		});

		it("resolves the comments directory under .mdly, not beside the .md", async () => {
			expect(commentsDirPath(WORKSPACE)).toBe(`${WORKSPACE}/.mdly/comments`);
		});
	});

	describe("R2 — every mutation appends exactly one line; earlier bytes never change", () => {
		it("keeps prior bytes byte-identical after a second append", async () => {
			const logPath = commentLogPath(WORKSPACE, DOC_ID);
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, openedEvent());
			const bytesAfterFirst = fs.getRaw(logPath)!.length;

			await appendCommentEvent(fs, WORKSPACE, DOC_ID, {
				id: "evt2",
				kind: "replied",
				threadId: "evt1",
				prev: "evt1",
				by: { kind: "human", id: "user1" },
				text: "Reply",
			});

			const bytesAfterSecond = fs.getRaw(logPath)!;
			expect(bytesAfterSecond.slice(0, bytesAfterFirst)).toEqual(
				fs.getRaw(logPath)!.slice(0, bytesAfterFirst),
			);
			const lines = new TextDecoder()
				.decode(bytesAfterSecond)
				.trim()
				.split("\n");
			expect(lines.length).toBe(2);
			expect(JSON.parse(lines[0]).id).toBe("evt1");
			expect(JSON.parse(lines[1]).id).toBe("evt2");
		});
	});

	describe("R3 — only four event kinds; writer refuses unknown kinds, writes nothing", () => {
		it("rejects an unknown kind and writes nothing", async () => {
			const invalid = {
				id: "evt1",
				kind: "pinned",
				threadId: "evt1",
				prev: null,
				by: { kind: "human", id: "user1" },
				text: "Invalid",
			};

			await expect(
				appendCommentEvent(fs, WORKSPACE, DOC_ID, invalid as any),
			).rejects.toThrow();
			expect(fs.getRaw(commentLogPath(WORKSPACE, DOC_ID))).toBeNull();
		});

		it("accepts all four valid event kinds", async () => {
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, openedEvent());
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, {
				id: "evt2",
				kind: "replied",
				threadId: "evt1",
				prev: "evt1",
				by: { kind: "human", id: "user1" },
				text: "Reply",
			});
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, {
				id: "evt3",
				kind: "resolved",
				threadId: "evt1",
				prev: "evt2",
				by: { kind: "human", id: "user1" },
			});
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, {
				id: "evt4",
				kind: "reopened",
				threadId: "evt1",
				prev: "evt3",
				by: { kind: "human", id: "user1" },
			});

			const kinds = (await readCommentEvents(fs, WORKSPACE, DOC_ID)).map(
				(e) => e.kind,
			);
			expect(kinds.sort()).toEqual(
				["thread-opened", "replied", "resolved", "reopened"].sort(),
			);
		});

		it("never crashes on a truncated/non-JSON line and never drops valid events", async () => {
			const logPath = commentLogPath(WORKSPACE, DOC_ID);
			await fs.appendText(logPath, `${JSON.stringify(openedEvent())}\n`);
			await fs.appendText(logPath, "TRUNCATED LINE\n");
			await fs.appendText(logPath, "{ invalid json\n");
			await fs.appendText(
				logPath,
				`${JSON.stringify({
					id: "evt2",
					kind: "replied",
					threadId: "evt1",
					prev: "evt1",
					by: { kind: "human", id: "user1" },
					text: "Reply",
				})}\n`,
			);

			const events = await readCommentEvents(fs, WORKSPACE, DOC_ID);
			expect(new Set(events.map((e) => e.id))).toEqual(new Set(["evt1", "evt2"]));
		});
	});

	describe("R6 — reader globs forked siblings and .conflict-* copies, merges by id", () => {
		it("merges a numbered fork and a .conflict-* copy by event id, each exactly once", async () => {
			const logDir = commentsDirPath(WORKSPACE);
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, openedEvent());

			const forkedPath = `${logDir}/${DOC_ID} 2.jsonl`;
			const forkEvent = {
				id: "evt2",
				kind: "replied" as const,
				threadId: "evt1",
				prev: "evt1",
				by: { kind: "human", id: "user2" },
				text: "Reply",
			};
			await fs.appendText(forkedPath, `${JSON.stringify(forkEvent)}\n`);

			const conflictPath = `${logDir}/${DOC_ID}.jsonl.conflict-20260827`;
			const conflictEvent = {
				id: "evt3",
				kind: "replied" as const,
				threadId: "evt1",
				prev: "evt1",
				by: { kind: "human", id: "user3" },
				text: "Another reply",
			};
			await fs.appendText(conflictPath, `${JSON.stringify(conflictEvent)}\n`);

			const siblings = await findCommentLogSiblings(fs, WORKSPACE, DOC_ID);
			expect(siblings.length).toBe(3);

			const events = await readCommentEvents(fs, WORKSPACE, DOC_ID);
			expect(events.length).toBe(3);
			expect(new Set(events.map((e) => e.id))).toEqual(
				new Set(["evt1", "evt2", "evt3"]),
			);
		});

		it("dedupes an event id repeated across the base log and a fork", async () => {
			const logDir = commentsDirPath(WORKSPACE);
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, openedEvent());

			const forkedPath = `${logDir}/${DOC_ID} 2.jsonl`;
			await fs.appendText(forkedPath, `${JSON.stringify(openedEvent())}\n`);

			const events = await readCommentEvents(fs, WORKSPACE, DOC_ID);
			expect(events.length).toBe(1);
		});
	});
});
