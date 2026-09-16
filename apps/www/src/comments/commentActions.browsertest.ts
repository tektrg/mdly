// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pushFileMock, registerSlotMock, remoteRows } = vi.hoisted(() => ({
	pushFileMock: vi.fn(),
	registerSlotMock: vi.fn(),
	remoteRows: new Map<
		string,
		{ path: string; content: string; contentHash?: string }
	>(),
}));

vi.mock("@mdly/cloudflare-client", async () => {
	const actual = await vi.importActual("@mdly/cloudflare-client");
	return {
		...(actual as Record<string, unknown>),
		createCloudflareBackend: () => ({
			pushFile: pushFileMock,
			getFiles: async () =>
				[...remoteRows.values()].map((row) => ({
					path: row.path,
					content: row.content,
					contentHash: row.contentHash ?? "hash",
					updatedAt: 1,
					deleted: false,
				})),
			getAssets: async () => [],
		}),
		createVersionLedger: () => ({ record() {}, has: () => false }),
		listWorkspaces: async () => [],
		registerDeviceSlot: registerSlotMock,
	};
});

import { CloudflareResponseError } from "@mdly/cloudflare-client";

import { initActions, refreshFiles, teardownActions } from "../store/actions";
import { workspaceStore } from "../store/state";
import {
	deleteCommentThread,
	ensureDeviceSlot,
	openCommentThread,
	reopenCommentThread,
	replyToCommentThread,
	resolveCommentThread,
	slotLogPath,
	threadHeadId,
} from "./commentActions";

const DOC_ID = "doc-1";
const CANONICAL = `.mdly/comments/${DOC_ID}.jsonl`;
const SLOT_PATH = `.mdly/comments/${DOC_ID} (3).jsonl`;

function seedCanonicalLog(lines: string[]): void {
	remoteRows.set(CANONICAL, {
		path: CANONICAL,
		content: lines.length > 0 ? `${lines.join("\n")}\n` : "",
	});
}

function pushedContents(): string[] {
	return pushFileMock.mock.calls.map((call) => call[0].content as string);
}

describe("web comment writes (write-back slice 6)", () => {
	beforeEach(() => {
		pushFileMock.mockReset();
		registerSlotMock.mockReset();
		registerSlotMock.mockResolvedValue(3);
		remoteRows.clear();
		localStorage.clear();
		teardownActions();
		initActions("ws-comments");
		// pushFile writes through to the fake remote so the post-write
		// refreshFiles() re-list observes them, like the real Worker.
		pushFileMock.mockImplementation(
			async (args: { path: string; content: string }) => {
				remoteRows.set(args.path, { path: args.path, content: args.content });
			},
		);
	});

	it("registers the device slot once, then reuses the cached slot", async () => {
		expect(await ensureDeviceSlot()).toBe(3);
		expect(await ensureDeviceSlot()).toBe(3);
		expect(registerSlotMock).toHaveBeenCalledTimes(1);
		expect(registerSlotMock).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "ws-comments",
				deviceId: expect.stringMatching(/^web-/),
			}),
		);
	});

	it("openThread appends a thread-opened event to the slot log, never the canonical log", async () => {
		seedCanonicalLog([]);
		await refreshFiles();
		await openCommentThread(
			DOC_ID,
			{ from: 0, to: 5, quote: "hello", mode: "quote" },
			"First!",
		);
		expect(pushFileMock).toHaveBeenCalledTimes(1);
		const call = pushFileMock.mock.calls[0]?.[0] as {
			path: string;
			content: string;
		};
		expect(call.path).toBe(SLOT_PATH);
		expect(call.path).toBe(slotLogPath(DOC_ID, 3));
		const event = JSON.parse(call.content.trim()) as {
			kind: string;
			prev: null;
			text: string;
			threadId: string;
			id: string;
		};
		expect(event.kind).toBe("thread-opened");
		expect(event.prev).toBeNull();
		expect(event.text).toBe("First!");
		expect(event.threadId).toBe(event.id);
		// Refresh picked the new sidecar up — the thread surface repaints.
		expect(workspaceStore.get().sidecars[SLOT_PATH]?.content).toBe(
			call.content,
		);
	});

	it("reply chains prev onto the thread head across slots", async () => {
		const opened = JSON.stringify({
			id: "aaa",
			threadId: "aaa",
			kind: "thread-opened",
			prev: null,
			by: { kind: "human", id: "mac", label: "Mac" },
			anchor: { from: 0, to: 5, quote: "hello", mode: "quote" },
			text: "Mac thread",
		});
		seedCanonicalLog([opened]);
		await refreshFiles();
		await replyToCommentThread(DOC_ID, "aaa", "Phone reply");
		const contents = pushedContents();
		expect(contents).toHaveLength(1);
		const event = JSON.parse(contents[0]?.trim() ?? "") as {
			kind: string;
			prev: string;
			threadId: string;
		};
		expect(event.kind).toBe("replied");
		expect(event.threadId).toBe("aaa");
		// Head is the canonical thread-opened event — cross-slot chaining.
		expect(event.prev).toBe("aaa");
	});

	it("resolve / reopen / delete append their kinds with head prev", async () => {
		seedCanonicalLog([]);
		await refreshFiles();
		await openCommentThread(
			DOC_ID,
			{ from: 0, to: 5, quote: "hello", mode: "quote" },
			"T",
		);
		const openedContent = pushedContents()[0] ?? "";
		const openedId = (JSON.parse(openedContent.trim()) as { id: string }).id;
		// Seed the slot log back so later mutations see the opened event.
		remoteRows.set(SLOT_PATH, { path: SLOT_PATH, content: openedContent });
		await refreshFiles();

		await resolveCommentThread(DOC_ID, openedId);
		await reopenCommentThread(DOC_ID, openedId);
		await deleteCommentThread(DOC_ID, openedId);
		const kinds = pushedContents()
			.slice(1)
			.map(
				(c) =>
					(JSON.parse(c.trim().split("\n").pop() ?? "") as { kind: string })
						.kind,
			);
		expect(kinds).toEqual(["resolved", "reopened", "deleted"]);
	});

	it("threadHeadId picks the unreferenced event with the greatest id", () => {
		const events = [
			{ id: "a1", threadId: "t", prev: null },
			{ id: "a2", threadId: "t", prev: "a1" },
			{ id: "a3", threadId: "t", prev: "a1" },
		] as never[];
		// Fork: a2 and a3 both children of a1 — greatest id wins.
		expect(threadHeadId(events, "t")).toBe("a3");
		expect(threadHeadId(events, "nope")).toBeNull();
		expect(threadHeadId([], "t")).toBeNull();
	});

	it("a 409 on the slot log retries once onto the winner's tail — no dropped event", async () => {
		// This tab read an empty slot log; another tab's event landed first.
		const winnerLine = JSON.stringify({
			id: "w1",
			threadId: "w1",
			kind: "thread-opened",
			prev: null,
		});
		seedCanonicalLog([]);
		await refreshFiles();
		pushFileMock.mockImplementationOnce(async () => {
			// Server truth moved under us — and the re-list below observes it.
			remoteRows.set(SLOT_PATH, {
				path: SLOT_PATH,
				content: `${winnerLine}\n`,
				contentHash: "hW",
			});
			throw new CloudflareResponseError("conflict", 409, "WRITE_CONFLICT", {
				error: "conflict",
				code: "WRITE_CONFLICT",
				currentContentHash: "hW",
				content: `${winnerLine}\n`,
			});
		});
		await openCommentThread(
			DOC_ID,
			{ from: 0, to: 5, quote: "hello", mode: "quote" },
			"Mine",
		);
		expect(pushFileMock).toHaveBeenCalledTimes(2);
		const retry = pushFileMock.mock.calls[1]?.[0] as {
			content: string;
			expectedContentHash: string;
		};
		// Retried against the winner's hash, both events preserved.
		expect(retry.expectedContentHash).toBe("hW");
		const lines = retry.content.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ id: "w1" });
		expect(JSON.parse(lines[1] ?? "")).toMatchObject({ kind: "thread-opened" });
	});
});
