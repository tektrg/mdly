// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backlinksFor } from "../lib/linkIndex";
import {
	currentLinkIndex,
	linkIndexStore,
	noteSavedLinkSource,
	resetLinkIndex,
	syncLinkIndex,
} from "./linkIndexStore";
import { workspacePathStore } from "./state";

const disk: Record<string, string> = {};
const read = vi.fn(async (path: string) => {
	const content = disk[path];
	if (content === undefined) throw new Error("missing");
	return content;
});

beforeEach(() => {
	resetLinkIndex();
	read.mockClear();
	for (const key of Object.keys(disk)) delete disk[key];
});

describe("syncLinkIndex", () => {
	it("reads every file once, then only changed files", async () => {
		disk["/ws/a.md"] = "[b](b.md)";
		disk["/ws/b.md"] = "no links";
		const files = [
			{ path: "/ws/a.md", modifiedAt: 1 },
			{ path: "/ws/b.md", modifiedAt: 1 },
		];
		await syncLinkIndex("/ws", files, read);
		expect(read).toHaveBeenCalledTimes(2);
		expect(linkIndexStore.get().status).toBe("ready");
		expect(backlinksFor(currentLinkIndex(), "/ws/b.md")).toHaveLength(1);

		read.mockClear();
		await syncLinkIndex("/ws", files, read);
		expect(read).not.toHaveBeenCalled();

		disk["/ws/a.md"] = "nothing now";
		await syncLinkIndex(
			"/ws",
			[{ path: "/ws/a.md", modifiedAt: 2 }, files[1] as never],
			read,
		);
		expect(read).toHaveBeenCalledTimes(1);
		expect(backlinksFor(currentLinkIndex(), "/ws/b.md")).toEqual([]);
	});

	it("drops deleted files and picks up renamed ones", async () => {
		disk["/ws/a.md"] = "[c](c.md)";
		await syncLinkIndex("/ws", [{ path: "/ws/a.md", modifiedAt: 1 }], read);
		disk["/ws/z.md"] = "[c](c.md)";
		await syncLinkIndex("/ws", [{ path: "/ws/z.md", modifiedAt: 1 }], read);
		expect(
			backlinksFor(currentLinkIndex(), "/ws/c.md").map((b) => b.sourcePath),
		).toEqual(["/ws/z.md"]);
	});

	it("re-resolves wiki links when a namesake appears or disappears in the listing", async () => {
		disk["/ws/src.md"] = "[[Note]] [[dir/Note]]";
		disk["/ws/deep/x/Note.md"] = "";
		disk["/ws/dir/Note.md"] = "";
		const files = [
			{ path: "/ws/src.md", modifiedAt: 1 },
			{ path: "/ws/deep/x/Note.md", modifiedAt: 1 },
			{ path: "/ws/dir/Note.md", modifiedAt: 1 },
		];
		await syncLinkIndex("/ws", files, read);
		const back = (p: string) =>
			backlinksFor(currentLinkIndex(), p).map((b) => b.line);
		expect(back("/ws/dir/Note.md")).toEqual([1, 1]);
		expect(back("/ws/deep/x/Note.md")).toEqual([]);
		read.mockClear();
		await syncLinkIndex("/ws", [files[0], files[1]] as never, read);
		expect(read).not.toHaveBeenCalled();
		expect(back("/ws/deep/x/Note.md")).toEqual([1]);
	});

	it("resets on workspace switch", async () => {
		disk["/ws/a.md"] = "[c](c.md)";
		await syncLinkIndex("/ws", [{ path: "/ws/a.md", modifiedAt: 1 }], read);
		await syncLinkIndex("/other", [], read);
		expect(currentLinkIndex().sources.size).toBe(0);
		expect(linkIndexStore.get().scope).toBe("/other");
	});

	it("applies a save immediately and re-reads it on the next sync", async () => {
		disk["/ws/a.md"] = "";
		const files = [{ path: "/ws/a.md", modifiedAt: 1 }];
		await syncLinkIndex("/ws", files, read);
		noteSavedLinkSource("/ws/a.md", "[c](c.md)");
		expect(backlinksFor(currentLinkIndex(), "/ws/c.md")).toHaveLength(1);
		read.mockClear();
		disk["/ws/a.md"] = "[c](c.md)";
		await syncLinkIndex("/ws", files, read);
		expect(read).toHaveBeenCalledTimes(1);
	});
});

describe("workspace change", () => {
	it("drops the index when the workspace path changes or closes", async () => {
		workspacePathStore.set("/ws");
		disk["/ws/a.md"] = "[b](b.md)";
		await syncLinkIndex("/ws", [{ path: "/ws/a.md", modifiedAt: 1 }], read);
		expect(linkIndexStore.get().scope).toBe("/ws");
		workspacePathStore.set(undefined);
		await new Promise((r) => setTimeout(r, 0));
		expect(linkIndexStore.get().scope).toBeNull();
		expect(currentLinkIndex().sources.size).toBe(0);
	});
});
