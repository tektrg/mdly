import { describe, it, expect, beforeEach } from "vitest";
import {
	listThreads,
	openThread,
	reply,
	resolve,
	reopen,
	type CommentStoreOptions,
} from "../src/commentStore.js";
import { appendCommentEvent, readCommentEvents } from "../src/commentLog.js";
import type { TextAnchor } from "../src/types.js";
import { createMemoryFileSystem, type MemoryFileSystem } from "./testFs.js";

const WORKSPACE = "/ws";
const DOC_ID = "d1";
const CURRENT_FLATTENED = "Hello world\nTarget sentence is here.\n";

const storeOptions: CommentStoreOptions = {
	readRevisionContent: async () => null,
	flattenDocument: (doc) => doc,
};

describe("commentStore", () => {
	let fs: MemoryFileSystem;

	beforeEach(() => {
		fs = createMemoryFileSystem();
	});

	describe("O2/s1-lifecycle-read-model — open/reply/resolve/reopen persist and read back", () => {
		it("walks through every state transition", async () => {
			const anchor: TextAnchor = {
				from: 12,
				to: 28,
				quote: "Target sentence",
				mode: "quote",
			};

			await openThread(fs, WORKSPACE, {
				docId: DOC_ID,
				author: { kind: "human", id: "user1" },
				anchor,
				text: "Check this",
			});

			let threads = await listThreads(fs, WORKSPACE, DOC_ID, CURRENT_FLATTENED, storeOptions);
			expect(threads.length).toBe(1);
			expect(threads[0].state).toBe("open");
			expect(threads[0].events.length).toBe(1);
			const threadId = threads[0].id;

			await reply(fs, WORKSPACE, {
				docId: DOC_ID,
				threadId,
				author: { kind: "human", id: "user2" },
				text: "Good point",
			});
			threads = await listThreads(fs, WORKSPACE, DOC_ID, CURRENT_FLATTENED, storeOptions);
			expect(threads[0].state).toBe("open");
			expect(threads[0].events.length).toBe(2);

			await resolve(fs, WORKSPACE, {
				docId: DOC_ID,
				threadId,
				author: { kind: "human", id: "user1" },
			});
			threads = await listThreads(fs, WORKSPACE, DOC_ID, CURRENT_FLATTENED, storeOptions);
			expect(threads[0].state).toBe("resolved");
			expect(threads[0].events.length).toBe(3);

			await reopen(fs, WORKSPACE, {
				docId: DOC_ID,
				threadId,
				author: { kind: "human", id: "user1" },
			});
			threads = await listThreads(fs, WORKSPACE, DOC_ID, CURRENT_FLATTENED, storeOptions);
			expect(threads[0].state).toBe("open");
			expect(threads[0].events.length).toBe(4);
		});
	});

	describe("R13 — reject-safe writes", () => {
		it("rejects a collapsed selection and writes nothing", async () => {
			const anchor: TextAnchor = { from: 10, to: 10, quote: "", mode: "quote" };
			await expect(
				openThread(fs, WORKSPACE, {
					docId: DOC_ID,
					author: { kind: "human", id: "user1" },
					anchor,
					text: "Comment",
				}),
			).rejects.toThrow();
			expect(await readCommentEvents(fs, WORKSPACE, DOC_ID)).toEqual([]);
		});

		it("rejects an empty quote even with a non-empty range", async () => {
			const anchor: TextAnchor = { from: 0, to: 5, quote: "", mode: "quote" };
			await expect(
				openThread(fs, WORKSPACE, {
					docId: DOC_ID,
					author: { kind: "human", id: "user1" },
					anchor,
					text: "Comment",
				}),
			).rejects.toThrow();
			expect(await readCommentEvents(fs, WORKSPACE, DOC_ID)).toEqual([]);
		});

		it("QA2 — a failed append surfaces a visible error, never a partial write", async () => {
			const failingFs: MemoryFileSystem = {
				...fs,
				appendText: async () => {
					throw new Error("EACCES: permission denied");
				},
			};
			const anchor: TextAnchor = { from: 0, to: 5, quote: "Hello", mode: "quote" };
			await expect(
				openThread(failingFs, WORKSPACE, {
					docId: DOC_ID,
					author: { kind: "human", id: "user1" },
					anchor,
					text: "Comment",
				}),
			).rejects.toThrow(/EACCES/);
			expect(await readCommentEvents(fs, WORKSPACE, DOC_ID)).toEqual([]);
		});
	});

	describe("R4/R5 — no server fields; ordering via prev, never timestamps", () => {
		it("never writes syncedAt/seq/serverId/at, and every event carries an id and prev", async () => {
			const anchor: TextAnchor = { from: 0, to: 5, quote: "Hello", mode: "quote" };
			await openThread(fs, WORKSPACE, {
				docId: DOC_ID,
				author: { kind: "human", id: "user1", label: "Test User" },
				anchor,
				text: "Comment",
			});

			const events = await readCommentEvents(fs, WORKSPACE, DOC_ID);
			for (const event of events) {
				const untyped = event as unknown as Record<string, unknown>;
				expect(untyped.syncedAt).toBeUndefined();
				expect(untyped.serverId).toBeUndefined();
				expect(untyped.seq).toBeUndefined();
				expect(untyped.at).toBeUndefined();
				expect(typeof event.id).toBe("string");
				expect(event.prev !== undefined).toBe(true);
			}
		});

		it("chains prev pointers opener -> reply -> reply, never by wall clock", async () => {
			const anchor: TextAnchor = { from: 0, to: 5, quote: "Hello", mode: "quote" };
			await openThread(fs, WORKSPACE, {
				docId: DOC_ID,
				author: { kind: "human", id: "user1" },
				anchor,
				text: "First",
			});
			const [opener] = await readCommentEvents(fs, WORKSPACE, DOC_ID);
			expect(opener.prev).toBeNull();

			await reply(fs, WORKSPACE, {
				docId: DOC_ID,
				threadId: opener.threadId,
				author: { kind: "human", id: "user2" },
				text: "Reply 1",
			});
			const events2 = await readCommentEvents(fs, WORKSPACE, DOC_ID);
			const reply1 = events2.find((e) => e.kind === "replied")!;
			expect(reply1.prev).toBe(opener.id);

			await reply(fs, WORKSPACE, {
				docId: DOC_ID,
				threadId: opener.threadId,
				author: { kind: "human", id: "user3" },
				text: "Reply 2",
			});
			const events3 = await readCommentEvents(fs, WORKSPACE, DOC_ID);
			const reply2 = events3.find((e) => e.kind === "replied" && e.id !== reply1.id)!;
			expect(reply2.prev).toBe(reply1.id);
		});
	});

	describe("QA15 — rapid consecutive actions chain prev correctly under the keyed lock", () => {
		it("fires open + 5 concurrent replies without forking the chain", async () => {
			const anchor: TextAnchor = { from: 0, to: 5, quote: "Hello", mode: "quote" };
			await openThread(fs, WORKSPACE, {
				docId: DOC_ID,
				author: { kind: "human", id: "user1" },
				anchor,
				text: "First",
			});
			const [opener] = await readCommentEvents(fs, WORKSPACE, DOC_ID);

			await Promise.all(
				Array.from({ length: 5 }, (_, i) =>
					reply(fs, WORKSPACE, {
						docId: DOC_ID,
						threadId: opener.threadId,
						author: { kind: "human", id: `user${i}` },
						text: `Reply ${i}`,
					}),
				),
			);

			const events = await readCommentEvents(fs, WORKSPACE, DOC_ID);
			expect(events.length).toBe(6);
			// Every prev must point at an id that actually exists, and the chain
			// from the opener must reach every reply with no fork (no two events
			// sharing the same prev).
			const prevCounts = new Map<string, number>();
			for (const e of events) {
				if (e.prev === null) continue;
				prevCounts.set(e.prev, (prevCounts.get(e.prev) ?? 0) + 1);
			}
			for (const count of prevCounts.values()) {
				expect(count).toBe(1);
			}
			const threads = await listThreads(fs, WORKSPACE, DOC_ID, CURRENT_FLATTENED, storeOptions);
			expect(threads[0].events.length).toBe(6);
		});
	});

	describe("QA5 — a genuine fork (two events appended with the same prev) keeps both, deterministically", () => {
		it("includes both sibling replies exactly once, in a stable order", async () => {
			const anchor: TextAnchor = { from: 0, to: 5, quote: "Hello", mode: "quote" };
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, {
				id: "opener",
				kind: "thread-opened",
				threadId: "opener",
				prev: null,
				by: { kind: "human", id: "user1" },
				anchor,
				text: "First",
			});
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, {
				id: "replyB",
				kind: "replied",
				threadId: "opener",
				prev: "opener",
				by: { kind: "human", id: "user2" },
				text: "From window B",
			});
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, {
				id: "replyA",
				kind: "replied",
				threadId: "opener",
				prev: "opener",
				by: { kind: "human", id: "user3" },
				text: "From window A",
			});

			const threads = await listThreads(fs, WORKSPACE, DOC_ID, CURRENT_FLATTENED, storeOptions);
			expect(threads.length).toBe(1);
			expect(threads[0].events.map((e) => e.id).sort()).toEqual([
				"opener",
				"replyA",
				"replyB",
			]);
			// Deterministic: re-reading produces the identical order.
			const again = await listThreads(fs, WORKSPACE, DOC_ID, CURRENT_FLATTENED, storeOptions);
			expect(again[0].events.map((e) => e.id)).toEqual(
				threads[0].events.map((e) => e.id),
			);
		});
	});

	describe("R6/QA6 — dangling prev and a prev cycle never hang the reader", () => {
		it("returns the reachable events for a dangling prev without hanging", async () => {
			const anchor: TextAnchor = { from: 0, to: 5, quote: "Hello", mode: "quote" };
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, {
				id: "opener",
				kind: "thread-opened",
				threadId: "opener",
				prev: null,
				by: { kind: "human", id: "user1" },
				anchor,
				text: "First",
			});
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, {
				id: "dangling",
				kind: "replied",
				threadId: "opener",
				prev: "does-not-exist",
				by: { kind: "human", id: "user2" },
				text: "Orphaned pointer",
			});

			const threads = await listThreads(fs, WORKSPACE, DOC_ID, CURRENT_FLATTENED, storeOptions);
			expect(threads.length).toBe(1);
			expect(threads[0].events.map((e) => e.id).sort()).toEqual([
				"dangling",
				"opener",
			]);
		});

		it("terminates on a prev cycle instead of looping forever", async () => {
			const anchor: TextAnchor = { from: 0, to: 5, quote: "Hello", mode: "quote" };
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, {
				id: "opener",
				kind: "thread-opened",
				threadId: "opener",
				prev: null,
				by: { kind: "human", id: "user1" },
				anchor,
				text: "First",
			});
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, {
				id: "a",
				kind: "replied",
				threadId: "opener",
				prev: "b",
				by: { kind: "human", id: "user1" },
				text: "a",
			});
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, {
				id: "b",
				kind: "replied",
				threadId: "opener",
				prev: "a",
				by: { kind: "human", id: "user1" },
				text: "b",
			});

			const threads = await listThreads(fs, WORKSPACE, DOC_ID, CURRENT_FLATTENED, storeOptions);
			expect(threads.length).toBe(1);
			expect(new Set(threads[0].events.map((e) => e.id))).toEqual(
				new Set(["opener", "a", "b"]),
			);
		});
	});

	describe("QA7b — a headless event (unknown threadId) never fabricates a phantom thread", () => {
		it("ignores a replied event whose threadId has no opener", async () => {
			await appendCommentEvent(fs, WORKSPACE, DOC_ID, {
				id: "headless",
				kind: "replied",
				threadId: "never-opened",
				prev: null,
				by: { kind: "human", id: "user1" },
				text: "orphan reply",
			});

			const threads = await listThreads(fs, WORKSPACE, DOC_ID, CURRENT_FLATTENED, storeOptions);
			expect(threads.length).toBe(0);
		});
	});

	describe("D10 — a reply after resolve reads the thread as open again", () => {
		it("derives state from the single merged head, not resolve-then-frozen", async () => {
			const anchor: TextAnchor = { from: 0, to: 5, quote: "Hello", mode: "quote" };
			await openThread(fs, WORKSPACE, {
				docId: DOC_ID,
				author: { kind: "human", id: "user1" },
				anchor,
				text: "First",
			});
			const [opener] = await readCommentEvents(fs, WORKSPACE, DOC_ID);
			await resolve(fs, WORKSPACE, {
				docId: DOC_ID,
				threadId: opener.threadId,
				author: { kind: "human", id: "user1" },
			});
			await reply(fs, WORKSPACE, {
				docId: DOC_ID,
				threadId: opener.threadId,
				author: { kind: "human", id: "user2" },
				text: "One more thing",
			});

			const threads = await listThreads(fs, WORKSPACE, DOC_ID, CURRENT_FLATTENED, storeOptions);
			expect(threads[0].state).toBe("open");
		});
	});

	describe("R20 — empty workspace shows no threads, no crash", () => {
		it("returns an empty list when nothing has ever been written", async () => {
			const threads = await listThreads(fs, WORKSPACE, DOC_ID, CURRENT_FLATTENED, storeOptions);
			expect(threads).toEqual([]);
		});
	});
});
