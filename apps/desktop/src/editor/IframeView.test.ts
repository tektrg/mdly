import { beforeEach, describe, expect, it, vi } from "vitest";

// IframeView captures window.desktopApi at import time (like the rest of the
// app), and transitively pulls in the full @mdly/workspace-kit runtime, which
// is expensive to re-evaluate. Unlike fileActions.test.ts/actions.test.ts's
// per-test `vi.resetModules()` pattern, this file stubs globals once at
// module load and imports IframeView a single time, resetting only the
// mocks/store state between tests.
const api = {
	readFileText: vi.fn(async (_path: string) => ""),
	writeFileText: vi.fn(async (_path: string, _content: string) => {}),
};

vi.stubGlobal("localStorage", {
	getItem: vi.fn(() => null),
	setItem: vi.fn(),
});
vi.stubGlobal("window", {
	desktopApi: api,
	setTimeout,
	clearTimeout,
});

const { applyMarkdownPatch } = await import("./IframeView");
const { appStore } = await import("../store/state");

describe("IframeView applyMarkdownPatch guard (R22, QA1b, QA2c)", () => {
	beforeEach(() => {
		api.readFileText.mockClear();
		api.writeFileText.mockClear();
	});

	it("blocks a body update while the editor has unsaved edits, without clobbering state", async () => {
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: "# Original\n\nunsaved edit",
				diskContent: "# Original",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		await expect(
			applyMarkdownPatch(path, { body: "patched body" }),
		).rejects.toThrow(/unsaved edits/i);

		expect(api.writeFileText).not.toHaveBeenCalled();
		// The unsaved edit must still be there — not silently discarded by the
		// rejected patch attempt.
		expect(appStore.get().document.content).toBe("# Original\n\nunsaved edit");
	});

	it("blocks a body update while an auto-applied external change has not been undone or saved over", async () => {
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				// diskContent tracks live disk state on auto-apply, so dirtiness here
				// comes only from an unsaved local edit made after the auto-apply —
				// isolating the same content !== diskContent guard as any other
				// unsaved-edit case, not from the externalChange kind itself.
				content: "changed outside\n\nunsaved edit",
				diskContent: "changed outside",
				externalChange: { kind: "applied", previousContent: "before" },
				status: "ready",
				error: null,
			},
		}));

		await expect(
			applyMarkdownPatch(path, { body: "patched body" }),
		).rejects.toThrow(/unsaved edits/i);
		expect(api.writeFileText).not.toHaveBeenCalled();
	});

	it("allows a body update when there is no pending review or conflict", async () => {
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: "# Original",
				diskContent: "# Original",
				externalChange: { kind: "none" },
				status: "ready",
				error: null,
			},
		}));

		await expect(
			applyMarkdownPatch(path, { body: "patched body" }),
		).resolves.toEqual(expect.stringContaining("patched body"));
		expect(api.writeFileText).toHaveBeenCalled();
	});
});
