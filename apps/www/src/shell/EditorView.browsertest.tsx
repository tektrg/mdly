// @vitest-environment happy-dom

import type { Editor } from "@tiptap/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "./EditorView";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { pushFileMock } = vi.hoisted(() => ({ pushFileMock: vi.fn() }));

vi.mock("@mdly/cloudflare-client", async () => {
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

import { initActions, teardownActions } from "../store/actions";

/**
 * Web write-back (R31 reversed 2026-09-15): apps/www's EditorView wrapper
 * leaves the shared kit editable, and an edit must travel the full path —
 * keystroke → staged push / unmount → forced save → `pushFile`.
 */
describe("apps/www EditorView is writable (write-back)", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		pushFileMock.mockReset();
		pushFileMock.mockResolvedValue(undefined);
		teardownActions();
		initActions("ws-test");
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		teardownActions();
		act(() => root.unmount());
		container.remove();
	});

	// An absolute image URL sidesteps this wrapper's asset-download-URL
	// resolution path (which needs a backend ctx) — this test is about
	// markdown-to-DOM rendering fidelity, not asset resolution, which is
	// exercised elsewhere.
	const MARKDOWN = [
		"# Title",
		"",
		"A paragraph with a [link](https://example.com), **bold** text, and *italic* text.",
		"",
		"![a photo](https://example.com/pic.png)",
		"",
	].join("\n");

	it("renders a link, image, bold, and italic on an editable ProseMirror surface", async () => {
		act(() => {
			root.render(
				<EditorView path="/workspace/note.md" initialMarkdown={MARKDOWN} />,
			);
		});

		// Links render as `<span data-href="…" data-link="true">`, not a native
		// `<a>` — see the shared kit's `engine/Link.ts` `renderHTML` (clicks are
		// intercepted by `LinkClickExtension` instead of native navigation).
		const link = container.querySelector<HTMLElement>(
			"[data-link='true'][data-href='https://example.com']",
		);
		expect(link).not.toBeNull();
		expect(link?.textContent).toBe("link");

		expect(container.querySelector("strong")?.textContent).toBe("bold");
		expect(container.querySelector("em")?.textContent).toBe("italic");

		// Image node views mount a tick after the sync render (React portal),
		// so wait for the <img> instead of asserting synchronously.
		await vi.waitFor(() => {
			expect(container.querySelector("img")).not.toBeNull();
		});
		const img = container.querySelector("img");
		expect(img?.getAttribute("src")).toBe("https://example.com/pic.png");

		const pmRoot = container.querySelector("[contenteditable]");
		expect(pmRoot).not.toBeNull();
		expect(pmRoot?.getAttribute("contenteditable")).toBe("true");
	});

	it("an edit reaches pushFile — typing is not a dead end", async () => {
		let editor: Editor | null = null;
		act(() => {
			root.render(
				<EditorView
					path="note.md"
					initialMarkdown="Hello world\n"
					onEditorReady={(ready) => {
						editor = ready;
					}}
				/>,
			);
		});
		expect(editor).not.toBeNull();
		const pmRoot = container.querySelector<HTMLElement>("[contenteditable]");
		expect(pmRoot).not.toBeNull();

		// The kit only treats an update as a save-worthy user edit when it
		// follows real user intent (keydown/paste/etc. inside a short
		// window) — a bare programmatic insert is deliberately ignored. So
		// mark intent exactly like a user pressing a key, then insert.
		act(() => {
			pmRoot?.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "a",
					bubbles: true,
					cancelable: true,
				}),
			);
			editor?.commands.insertContent(" appended");
		});
		expect(container.textContent).toContain("appended");

		// Unmount = the kit's forced-save path (same as switching files):
		// onSave must push the latest markdown, not the staged debounce.
		// (The staged 1s debounce may ALSO fire later with identical content
		// — idempotent upsert, harmless — so wait for "called", then inspect
		// the first call instead of asserting an exact count.)
		await act(async () => {
			root.unmount();
		});
		await vi.waitFor(() => {
			expect(pushFileMock).toHaveBeenCalled();
		});
		const pushed = pushFileMock.mock.calls[0]?.[0] as {
			path: string;
			content: string;
		};
		expect(pushed.path).toBe("note.md");
		expect(pushed.content).toContain("appended");
	});
});
