import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDesktopApi,
	loadStoreActions,
} from "../../store/storeTestHarness";

const PATH = "/workspace/note.md";
const TARGET = { path: PATH, openPath: PATH };
const ORIGINAL = "---\ntitle: Plan\nstatus: todo\n---\n# Body\n";
const EDITED = "---\ntitle: Plan\nstatus: done\n---\n# Body\n";

/** A mock desktop API over one in-memory file, with the main-process CAS semantics. */
function fakeDisk(initial: string | null) {
	const disk = { text: initial };
	const api = {
		...createDesktopApi(),
		writeFileTextIfUnchanged: vi.fn(
			async (_path: string, expected: string, content: string) => {
				if (disk.text === null) return { ok: false, reason: "missing" };
				if (disk.text !== expected) return { ok: false, reason: "changed" };
				disk.text = content;
				return { ok: true };
			},
		),
	};
	api.readFileText.mockImplementation(async () => {
		if (disk.text === null) throw new Error("ENOENT");
		return disk.text;
	});
	return { api, disk };
}

async function load(api: ReturnType<typeof fakeDisk>["api"]) {
	const store = await loadStoreActions(api);
	const write = await import("./propertyWrite");
	const scan = await import("./propertyScanStore");
	return { ...store, ...write, ...scan };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function openNote(loaded: Loaded, content: string, diskContent: string) {
	loaded.appStore.set((current) => ({
		...current,
		document: {
			...current.document,
			currentPath: PATH,
			lastOpenedPath: PATH,
			content,
			diskContent,
			externalChange: { kind: "none" },
			status: "ready",
			error: null,
		},
	}));
}

describe("writeDocumentProperty", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("writes through the main-process compare-and-swap with a history cause", async () => {
		const { api, disk } = fakeDisk(ORIGINAL);
		const loaded = await load(api);
		const result = await loaded.writeDocumentProperty(TARGET, "Status", "done");
		expect(result).toEqual({ ok: true, changed: true });
		expect(api.writeFileTextIfUnchanged).toHaveBeenCalledWith(
			PATH,
			ORIGINAL,
			EDITED,
			{ historyCause: "manual" },
		);
		expect(api.writeFileText).not.toHaveBeenCalled();
		expect(disk.text).toBe(EDITED);
	});

	it("updates the property scan for that path optimistically", async () => {
		const { api } = fakeDisk(ORIGINAL);
		const loaded = await load(api);
		await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(loaded.propertyScanStore.get().propertiesByPath[PATH]).toEqual({
			title: { type: "text", value: "Plan" },
			status: { type: "text", value: "done" },
		});
	});

	it("refuses a dirty open note and writes nothing", async () => {
		const { api } = fakeDisk(ORIGINAL);
		const loaded = await load(api);
		openNote(loaded, `${ORIGINAL}typed`, ORIGINAL);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(result.ok ? "" : result.reason).toMatch(/unsaved edits/);
		expect(api.writeFileTextIfUnchanged).not.toHaveBeenCalled();
		expect(loaded.viewerStore.get().content).toBe(`${ORIGINAL}typed`);
	});

	it("refuses when the open note's disk copy moved past the editor baseline", async () => {
		const { api } = fakeDisk(`${ORIGINAL}external`);
		const loaded = await load(api);
		openNote(loaded, ORIGINAL, ORIGINAL);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(result.ok).toBe(false);
		expect(api.writeFileTextIfUnchanged).not.toHaveBeenCalled();
	});

	it("aborts when main reports the file changed (compare-and-swap)", async () => {
		const { api, disk } = fakeDisk(ORIGINAL);
		api.writeFileTextIfUnchanged.mockImplementationOnce(async () => {
			disk.text = `${ORIGINAL}agent`;
			return { ok: false, reason: "changed" };
		});
		const loaded = await load(api);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(result.ok ? "" : result.reason).toMatch(/changed while saving/);
		expect(disk.text).toBe(`${ORIGINAL}agent`);
	});

	it("refuses a note that is not valid UTF-8 (lossy read) without writing", async () => {
		const { api } = fakeDisk("---\nstatus: caf�\n---\n");
		const loaded = await load(api);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(result.ok ? "" : result.reason).toMatch(/not UTF-8/);
		expect(api.writeFileTextIfUnchanged).not.toHaveBeenCalled();
	});

	it("refuses a deleted note instead of recreating it", async () => {
		const { api, disk } = fakeDisk(ORIGINAL);
		api.writeFileTextIfUnchanged.mockImplementationOnce(async () => {
			disk.text = null;
			return { ok: false, reason: "missing" };
		});
		const loaded = await load(api);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(result.ok ? "" : result.reason).toMatch(/no longer exists/);
		expect(disk.text).toBeNull();
	});

	it("serializes rapid double drops: the second edit re-reads the first's result", async () => {
		const { api, disk } = fakeDisk(ORIGINAL);
		const loaded = await load(api);
		const [first, second] = await Promise.all([
			loaded.writeDocumentProperty(TARGET, "status", "doing"),
			loaded.writeDocumentProperty(TARGET, "due", "2026-10-05"),
		]);
		expect(first).toEqual({ ok: true, changed: true });
		expect(second).toEqual({ ok: true, changed: true });
		expect(disk.text).toBe(
			"---\ntitle: Plan\nstatus: doing\ndue: 2026-10-05\n---\n# Body\n",
		);
	});

	it("refuses (writes nothing) when the front matter cannot be edited safely", async () => {
		const { api } = fakeDisk("---\nstatus: a\nstatus: b\n---\n");
		const loaded = await load(api);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "c");
		expect(result.ok).toBe(false);
		expect(api.writeFileTextIfUnchanged).not.toHaveBeenCalled();
	});

	it("does not write when the value is already set", async () => {
		const { api } = fakeDisk(ORIGINAL);
		const loaded = await load(api);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "todo");
		expect(result).toEqual({ ok: true, changed: false });
		expect(api.writeFileTextIfUnchanged).not.toHaveBeenCalled();
	});

	it("moves a clean open note's buffer only after the write succeeded", async () => {
		const { api } = fakeDisk(ORIGINAL);
		const loaded = await load(api);
		openNote(loaded, ORIGINAL, ORIGINAL);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(result).toEqual({ ok: true, changed: true });
		expect(loaded.viewerStore.get().content).toBe(EDITED);
		expect(loaded.viewerStore.get().diskContent).toBe(EDITED);
	});

	it("leaves an open note's buffer untouched when the write is refused", async () => {
		const { api } = fakeDisk(ORIGINAL);
		api.writeFileTextIfUnchanged.mockResolvedValueOnce({
			ok: false,
			reason: "changed",
		});
		const loaded = await load(api);
		openNote(loaded, ORIGINAL, ORIGINAL);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(result.ok).toBe(false);
		expect(loaded.viewerStore.get().content).toBe(ORIGINAL);
		expect(loaded.viewerStore.get().diskContent).toBe(ORIGINAL);
	});

	it("merges the edit into a buffer the user typed into while the write was in flight", async () => {
		const { api, disk } = fakeDisk(ORIGINAL);
		const loaded = await load(api);
		openNote(loaded, ORIGINAL, ORIGINAL);
		api.writeFileTextIfUnchanged.mockImplementationOnce(
			async (_path: string, _expected: string, content: string) => {
				disk.text = content;
				loaded.updateEditorContent(PATH, `${ORIGINAL}typed`);
				return { ok: true };
			},
		);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(result).toEqual({ ok: true, changed: true });
		// The user's text is kept AND carries the property edit, so the next
		// save cannot drop it; the baseline is the file now on disk.
		expect(loaded.viewerStore.get().content).toBe(`${EDITED}typed`);
		expect(loaded.viewerStore.get().diskContent).toBe(EDITED);
	});

	it("keeps the old baseline when the typed buffer cannot take the edit", async () => {
		const { api, disk } = fakeDisk(ORIGINAL);
		const loaded = await load(api);
		openNote(loaded, ORIGINAL, ORIGINAL);
		const broken = "---\nstatus: [oops\n---\n";
		api.writeFileTextIfUnchanged.mockImplementationOnce(
			async (_path: string, _expected: string, content: string) => {
				disk.text = content;
				loaded.updateEditorContent(PATH, broken);
				return { ok: true };
			},
		);
		await loaded.writeDocumentProperty(TARGET, "status", "done");
		// Baseline unchanged: the editor sees the disk change as an external
		// edit (auto-apply + Undo) instead of overwriting it on the next save.
		expect(loaded.viewerStore.get().content).toBe(broken);
		expect(loaded.viewerStore.get().diskContent).toBe(ORIGINAL);
	});
});
