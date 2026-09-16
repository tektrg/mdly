// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { pushFileMock } = vi.hoisted(() => ({ pushFileMock: vi.fn() }));

vi.mock("@mdly/cloudflare-client", async () => {
	// Keep the real error classes: `describeApiError` does `instanceof`
	// checks against them, and a stub without them throws at check time.
	const actual = await vi.importActual("@mdly/cloudflare-client");
	return {
		...(actual as Record<string, unknown>),
		createCloudflareBackend: () => ({
			pushFile: pushFileMock,
			getFiles: async () => [],
			getAssets: async () => [],
		}),
		createVersionLedger: () => ({ record() {}, has: () => false }),
		listWorkspaces: async () => [],
	};
});

import { CloudflareResponseError } from "@mdly/cloudflare-client";
import {
	flushPendingSave,
	initActions,
	saveNoteNow,
	teardownActions,
	updateEditorContent,
} from "./actions";
import { viewerStore, workspaceStore } from "./state";

// SHA-256 hex of "hello" (UTF-8) — proves the web client hashes exactly the
// way the sync engine does, so the Mac won't see phantom divergence after a
// web push.
const HELLO_HASH =
	"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

/**
 * Real timers, not fake: the push chain goes through `crypto.subtle.digest`,
 * a genuine async operation fake timers can't fast-forward — faking only
 * moved pushes across test boundaries. Four ~1.1s waits ≈ 5s total.
 */
const waitForDebounce = () => new Promise((r) => setTimeout(r, 1100));

function openNote(path: string): void {
	viewerStore.set({
		...viewerStore.get(),
		currentPath: path,
		status: "ready",
		error: null,
		saveError: null,
		basedOnHash: "old-hash",
	});
	workspaceStore.set({
		...workspaceStore.get(),
		files: [{ path, contentHash: "old-hash", updatedAt: 1, deleted: false }],
	});
}

describe("web save client (write-back slice 2)", () => {
	beforeEach(() => {
		pushFileMock.mockReset();
		pushFileMock.mockResolvedValue(undefined);
		teardownActions();
		initActions("ws-1");
		openNote("note.md");
	});

	it("pushes a debounced edit with a sync-compatible content hash", async () => {
		updateEditorContent("note.md", "hello");
		expect(pushFileMock).not.toHaveBeenCalled();
		await waitForDebounce();
		expect(pushFileMock).toHaveBeenCalledTimes(1);
		expect(pushFileMock).toHaveBeenCalledWith({
			workspaceId: "ws-1",
			path: "note.md",
			contentHash: HELLO_HASH,
			content: "hello",
			deviceId: expect.stringMatching(/^web-/),
			expectedContentHash: "old-hash",
		});
		// Baseline advances to what we wrote; banner clears.
		expect(viewerStore.get().basedOnHash).toBe(HELLO_HASH);
		expect(viewerStore.get().saveError).toBeNull();
		expect(
			workspaceStore.get().files.find((f) => f.path === "note.md")?.contentHash,
		).toBe(HELLO_HASH);
	});

	it("coalesces rapid keystrokes into one push of the latest content", async () => {
		updateEditorContent("note.md", "h");
		updateEditorContent("note.md", "he");
		updateEditorContent("note.md", "hello");
		await waitForDebounce();
		expect(pushFileMock).toHaveBeenCalledTimes(1);
		expect(pushFileMock.mock.calls[0]?.[0]).toMatchObject({
			content: "hello",
		});
	});

	it("flushes the old path first when the open file switches", async () => {
		updateEditorContent("note.md", "hello");
		updateEditorContent("other.md", "world");
		await waitForDebounce();
		const paths = pushFileMock.mock.calls.map((call) => call[0].path);
		expect(paths).toEqual(["note.md", "other.md"]);
	});

	it("records a failed push on saveError without touching editor status", async () => {
		pushFileMock.mockRejectedValueOnce(new Error("boom"));
		updateEditorContent("note.md", "hello");
		await waitForDebounce();
		const viewer = viewerStore.get();
		expect(viewer.saveError).toBe("boom");
		expect(viewer.status).toBe("ready");
		// basedOnHash stays at the old baseline — our words never landed.
		expect(viewer.basedOnHash).toBe("old-hash");
	});

	it("saveNoteNow pushes immediately with no debounce", async () => {
		await saveNoteNow("note.md", "hello");
		expect(pushFileMock).toHaveBeenCalledTimes(1);
		expect(pushFileMock.mock.calls[0]?.[0]).toMatchObject({
			content: "hello",
			contentHash: HELLO_HASH,
		});
	});

	it("flushPendingSave with nothing staged pushes nothing", async () => {
		await flushPendingSave();
		expect(pushFileMock).not.toHaveBeenCalled();
	});

	it("sends the viewer baseline as the concurrency guard", async () => {
		await saveNoteNow("note.md", "hello");
		expect(pushFileMock.mock.calls[0]?.[0]).toMatchObject({
			expectedContentHash: "old-hash",
		});
	});

	it("a 409 preserves both copies and raises the conflict banner", async () => {
		pushFileMock.mockRejectedValueOnce(
			new CloudflareResponseError("conflict", 409, "WRITE_CONFLICT", {
				error: "conflict",
				code: "WRITE_CONFLICT",
				currentContentHash: "mac-hash",
				content: "mac words",
			}),
		);
		pushFileMock.mockResolvedValueOnce(undefined);
		await saveNoteNow("note.md", "my words");

		// Second push = our words preserved under a conflict-copy name.
		expect(pushFileMock).toHaveBeenCalledTimes(2);

		// Second push = our words preserved under a conflict-copy name.
		expect(pushFileMock).toHaveBeenCalledTimes(2);
		const copyArg = pushFileMock.mock.calls[1]?.[0] as {
			path: string;
			content: string;
		};
		expect(copyArg.path).toMatch(/^note\.conflict-\d+\.md$/);
		expect(copyArg.content).toBe("my words");

		// Banner state: baseline reconciled to remote, editor keeps our words.
		const viewer = viewerStore.get();
		expect(viewer.externalChange).toMatchObject({
			kind: "conflict",
			copyPath: copyArg.path,
		});
		expect(viewer.basedOnHash).toBe("mac-hash");
		expect(viewer.saveError).toBeNull();
	});

	it("a 409 with a malformed body falls back to the save-error banner", async () => {
		pushFileMock.mockRejectedValueOnce(
			new CloudflareResponseError("conflict", 409, "WRITE_CONFLICT", {
				bogus: true,
			}),
		);
		await saveNoteNow("note.md", "my words");
		expect(pushFileMock).toHaveBeenCalledTimes(1);
		expect(viewerStore.get().saveError).not.toBeNull();
		expect(viewerStore.get().externalChange).toMatchObject({
			kind: "none",
		});
	});
});
