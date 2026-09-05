// @vitest-environment happy-dom
import type { CommentOptions } from "@mdly/workspace-kit";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SidecarEntry } from "../store/sidecars";
import { resetState, workspaceStore } from "../store/state";
import { resetDocIdCache } from "./docId";
import { useCommentOptions } from "./useCommentOptions";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const anchor = {
	from: 0,
	to: 5,
	quote: "hello",
	mode: "quote" as const,
};

const macBy = { kind: "human", id: "mac-1", label: "Mac" } as const;
const phoneBy = { kind: "human", id: "phone-1", label: "Safari - iPhone" } as const;

const e1 = {
	id: "e1",
	kind: "thread-opened",
	prev: null,
	threadId: "t1",
	by: macBy,
	anchor,
	text: "Mac thread",
};
const e2 = {
	id: "e2",
	kind: "replied",
	prev: "e1",
	threadId: "t1",
	by: phoneBy,
	text: "phone reply",
};
const e3 = {
	id: "e3",
	kind: "thread-opened",
	prev: null,
	threadId: "t2",
	by: phoneBy,
	anchor,
	text: "second thread",
};
const e4 = {
	id: "e4",
	kind: "replied",
	prev: "e3",
	threadId: "t2",
	by: macBy,
	text: "reply two",
};

function entry(path: string, lines: unknown[]): SidecarEntry {
	const content = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
	return { path, content, contentHash: path, updatedAt: 1 };
}

function seedSidecars() {
	const sidecars: Record<string, SidecarEntry> = {
		".mdly/history/index.jsonl": entry(".mdly/history/index.jsonl", [
			{ id: "a1", at: 1, event: "assign", docId: "doc-1", path: "note.md" },
		]),
		".mdly/comments/doc-1.jsonl": entry(".mdly/comments/doc-1.jsonl", [e1]),
		".mdly/comments/doc-1 2.jsonl": entry(".mdly/comments/doc-1 2.jsonl", [
			e2,
			e3,
		]),
		// Slot 3 repeats e2 (same event id) and adds e4.
		".mdly/comments/doc-1 3.jsonl": entry(".mdly/comments/doc-1 3.jsonl", [
			e2,
			e4,
		]),
	};
	workspaceStore.set((s) => ({ ...s, sidecars, commentsVersion: 7 }));
}

let latest: CommentOptions | undefined;

function Probe({ path }: { path: string }) {
	latest = useCommentOptions(path);
	return null;
}

async function renderPath(path: string) {
	latest = undefined;
	const el = document.createElement("div");
	document.body.appendChild(el);
	const root = createRoot(el);
	await act(async () => {
		root.render(<Probe path={path} />);
	});
	// Flush the docId effect's promise and the resulting state update.
	await act(async () => {});
	await act(async () => {});
	const unmount = () => {
		act(() => root.unmount());
		el.remove();
	};
	return unmount;
}

afterEach(() => {
	resetState();
	resetDocIdCache();
});

describe("useCommentOptions (read-only)", () => {
	it("merges three sibling logs: every thread visible, deduped by event id", async () => {
		seedSidecars();
		const unmount = await renderPath("note.md");
		try {
			expect(latest?.docId).toBe("doc-1");
			const threads = await latest?.getThreads("doc-1");
			expect(threads?.map((t) => t.id)).toEqual(["t1", "t2"]);
			const t1 = threads?.find((t) => t.id === "t1");
			const t2 = threads?.find((t) => t.id === "t2");
			expect(t1?.opener.text).toBe("Mac thread");
			// e2 appears in slots 2 AND 3 but survives exactly once
			// (listThreads keeps the opener first in events).
			expect(t1?.events.map((e) => e.id)).toEqual(["e1", "e2"]);
			expect(t2?.events.map((e) => e.id)).toEqual(["e3", "e4"]);
		} finally {
			unmount();
		}
	});

	it("unknown path stays dark: undefined, no crash", async () => {
		seedSidecars();
		const unmount = await renderPath("missing.md");
		try {
			expect(latest).toBeUndefined();
		} finally {
			unmount();
		}
	});

	it("builds the device author and the unavailable-revision signals", async () => {
		seedSidecars();
		const unmount = await renderPath("note.md");
		try {
			expect(latest?.currentAuthor.kind).toBe("human");
			expect(typeof latest?.currentAuthor.label).toBe("string");
			await expect(latest?.getHeadRevisionId()).resolves.toBeNull();
			await expect(latest?.readRevisionContent("rev-1")).resolves.toBeNull();
			expect(latest?.refreshSignal).toBe(7);
		} finally {
			unmount();
		}
	});

	it("commentsVersion bump changes refreshSignal", async () => {
		seedSidecars();
		const unmount = await renderPath("note.md");
		try {
			expect(latest?.refreshSignal).toBe(7);
			await act(async () => {
				workspaceStore.set((s) => ({ ...s, commentsVersion: 8 }));
			});
			expect(latest?.refreshSignal).toBe(8);
		} finally {
			unmount();
		}
	});

	it("mutations reject with a coming-soon explanation (Step 8 replaces them)", async () => {
		seedSidecars();
		const unmount = await renderPath("note.md");
		try {
			await expect(latest?.onReply("t1", "x")).rejects.toThrow("coming soon");
			await expect(latest?.onResolve("t1")).rejects.toThrow("coming soon");
			await expect(latest?.onReopen("t1")).rejects.toThrow("coming soon");
			await expect(latest?.onDelete("t1")).rejects.toThrow("coming soon");
			await expect(
				latest?.onOpenThread(
					{ from: 0, to: 1, quote: "h", mode: "quote" },
					"x",
				),
			).rejects.toThrow("coming soon");
		} finally {
			unmount();
		}
	});
});
