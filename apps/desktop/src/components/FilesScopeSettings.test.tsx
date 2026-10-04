// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesScope } from "../desktopApi/types";
import { FilesScopeSettings } from "./FilesScopeSettings";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { getFilesScope, setFilesScope, countFilesInScope, refreshFiles } =
	vi.hoisted(() => ({
		getFilesScope: vi.fn(),
		setFilesScope: vi.fn(),
		countFilesInScope: vi.fn(),
		refreshFiles: vi.fn(),
	}));

vi.mock("../desktopApi", () => ({
	desktopApi: {
		getFilesScope,
		setFilesScope,
		countFilesInScope,
		saveFilesScopeDefaults: vi.fn(),
	},
}));
vi.mock("../store/actions", () => ({ refreshFiles }));

const WORKSPACE_PATH = "/workspace/demo";

const LOADED_SCOPE: FilesScope = {
	respectGitignore: true,
	rules: [{ pattern: ".claude", inApp: true, synced: false }],
};

async function flush() {
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("FilesScopeSettings", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.useFakeTimers();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		getFilesScope.mockResolvedValue({
			scope: LOADED_SCOPE,
			isCustomized: false,
			builtInPatterns: [".git", "node_modules"],
		});
		setFilesScope.mockImplementation(async (_path, scope) => scope);
		countFilesInScope.mockResolvedValue({ visible: 12, synced: 7 });
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	async function render() {
		await act(async () => {
			root.render(<FilesScopeSettings workspacePath={WORKSPACE_PATH} />);
			await flush();
		});
	}

	function checkbox(label: string): HTMLInputElement {
		const el = container.querySelector<HTMLInputElement>(
			`input[aria-label="${label}"]`,
		);
		if (!el) throw new Error(`no checkbox "${label}"`);
		return el;
	}

	it("shows built-in rows locked and migrated rows as In app ✓ / Synced ✗", async () => {
		await render();
		expect(checkbox(".git in app").disabled).toBe(true);
		expect(checkbox(".git synced").disabled).toBe(true);
		expect(checkbox(".claude in app").checked).toBe(true);
		expect(checkbox(".claude synced").checked).toBe(false);
	});

	it("unchecking In app forces Synced off and disables it", async () => {
		await render();
		await act(async () => {
			checkbox(".claude synced").click();
			await flush();
		});
		expect(setFilesScope).toHaveBeenLastCalledWith(WORKSPACE_PATH, {
			respectGitignore: true,
			rules: [{ pattern: ".claude", inApp: true, synced: true }],
		});
		await act(async () => {
			checkbox(".claude in app").click();
			await flush();
		});
		expect(setFilesScope).toHaveBeenLastCalledWith(WORKSPACE_PATH, {
			respectGitignore: true,
			rules: [{ pattern: ".claude", inApp: false, synced: false }],
		});
		expect(checkbox(".claude synced").disabled).toBe(true);
		expect(refreshFiles).toHaveBeenCalledWith(WORKSPACE_PATH);
	});

	it("shows live visible/synced counts", async () => {
		await render();
		await act(async () => {
			vi.advanceTimersByTime(400);
			await flush();
		});
		expect(container.textContent).toContain("12 visible · 7 synced");
	});
});
