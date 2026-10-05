import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDesktopApi,
	loadStoreActions,
	type MockDesktopApi,
} from "../../store/storeTestHarness";

const PATH = "/workspace/note.md";
const TARGET = { path: PATH, openPath: PATH };
const ORIGINAL = "---\ntitle: Plan\nstatus: todo\n---\n# Body\n";
const EDITED = "---\ntitle: Plan\nstatus: done\n---\n# Body\n";

async function load(api: MockDesktopApi) {
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

	it("writes a closed note through writeFileText with a history cause", async () => {
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue(ORIGINAL);
		const loaded = await load(api);
		const result = await loaded.writeDocumentProperty(TARGET, "Status", "done");
		expect(result).toEqual({ ok: true, changed: true });
		expect(api.writeFileText).toHaveBeenCalledTimes(1);
		expect(api.writeFileText).toHaveBeenCalledWith(PATH, EDITED, {
			historyCause: "manual",
		});
	});

	it("updates the property scan for that path optimistically", async () => {
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue(ORIGINAL);
		const loaded = await load(api);
		await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(loaded.propertyScanStore.get().propertiesByPath[PATH]).toEqual({
			title: { type: "text", value: "Plan" },
			status: { type: "text", value: "done" },
		});
	});

	it("refuses a dirty open note and writes nothing", async () => {
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue(ORIGINAL);
		const loaded = await load(api);
		openNote(loaded, `${ORIGINAL}typed`, ORIGINAL);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toMatch(/unsaved edits/);
		expect(api.writeFileText).not.toHaveBeenCalled();
		expect(loaded.viewerStore.get().content).toBe(`${ORIGINAL}typed`);
	});

	it("refuses when the open note's disk copy moved past the editor baseline", async () => {
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue(`${ORIGINAL}external`);
		const loaded = await load(api);
		openNote(loaded, ORIGINAL, ORIGINAL);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(result.ok).toBe(false);
		expect(api.writeFileText).not.toHaveBeenCalled();
	});

	it("aborts when the file changes between read and write (compare-and-swap)", async () => {
		const api = createDesktopApi();
		api.readFileText
			.mockResolvedValueOnce(ORIGINAL)
			.mockResolvedValueOnce(`${ORIGINAL}agent wrote this`);
		const loaded = await load(api);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toMatch(/changed while saving/);
		expect(api.writeFileText).not.toHaveBeenCalled();
	});

	it("refuses (writes nothing) when the front matter cannot be edited safely", async () => {
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue("---\nstatus: a\nstatus: b\n---\n");
		const loaded = await load(api);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "c");
		expect(result.ok).toBe(false);
		expect(api.writeFileText).not.toHaveBeenCalled();
	});

	it("does not write when the value is already set", async () => {
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue(ORIGINAL);
		const loaded = await load(api);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "todo");
		expect(result).toEqual({ ok: true, changed: false });
		expect(api.writeFileText).not.toHaveBeenCalled();
	});

	it("saves a clean open note through the editor path, buffer included", async () => {
		const api = createDesktopApi();
		let disk = ORIGINAL;
		api.readFileText.mockImplementation(async () => disk);
		api.writeFileText.mockImplementation(
			async (_path: string, text: string) => {
				disk = text;
			},
		);
		const loaded = await load(api);
		openNote(loaded, ORIGINAL, ORIGINAL);
		const result = await loaded.writeDocumentProperty(TARGET, "status", "done");
		expect(result).toEqual({ ok: true, changed: true });
		expect(api.writeFileText).toHaveBeenCalledWith(PATH, EDITED, {
			historyCause: "manual",
		});
		expect(loaded.viewerStore.get().content).toBe(EDITED);
		expect(loaded.viewerStore.get().diskContent).toBe(EDITED);
	});
});
