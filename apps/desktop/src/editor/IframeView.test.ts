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

	it("blocks a body update while a review is pending, without silently clearing externalChange", async () => {
		const path = "/workspace/note.md";
		const original = "# Original";
		const externalEditText = "# Original\n\nExternal edit";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				content: original,
				diskContent: original,
				externalChange: { kind: "review", diskContent: externalEditText },
				status: "ready",
				error: null,
			},
		}));

		await expect(
			applyMarkdownPatch(path, { body: "patched body" }),
		).rejects.toThrow(/unsaved edits/i);

		expect(api.writeFileText).not.toHaveBeenCalled();
		// The pending review must still be there for the user to act on — not
		// silently discarded by the rejected patch attempt.
		expect(appStore.get().document.externalChange).toEqual({
			kind: "review",
			diskContent: externalEditText,
		});
	});

	it("still blocks a body update for a real conflict, matching pre-Slice-3 behavior", async () => {
		const path = "/workspace/note.md";

		appStore.set((current) => ({
			...current,
			document: {
				...current.document,
				currentPath: path,
				lastOpenedPath: path,
				// Content matches the conflict's own baseline exactly, so the block
				// below can only come from the "conflict" kind check, not a genuine
				// content mismatch — isolating the guard-sweep behavior under test.
				content: "changed outside",
				diskContent: "before",
				externalChange: { kind: "conflict", diskContent: "changed outside" },
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
