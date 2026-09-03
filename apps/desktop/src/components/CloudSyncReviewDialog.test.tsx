// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncPreview } from "../desktopApi/types";
import { CloudSyncReviewDialog } from "./CloudSyncReviewDialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { getCloudSyncPreview, onCloudSyncProgressChange } = vi.hoisted(() => ({
	getCloudSyncPreview: vi.fn(),
	onCloudSyncProgressChange: vi.fn(),
}));

vi.mock("../desktopApi", () => ({
	desktopApi: { getCloudSyncPreview, onCloudSyncProgressChange },
}));

const WORKSPACE_PATH = "/workspace/demo";

const PREVIEW: SyncPreview = {
	folders: [
		{ folder: "docs", fileCount: 10, bytes: 1000 },
		{ folder: "(root)", fileCount: 1, bytes: 100 },
		{
			folder: "vendor",
			fileCount: 1001,
			bytes: 0,
			autoExcluded: "gitignored",
		},
	],
	totalOps: 11,
	toPush: 11,
	toPull: 0,
	conflicts: 0,
};

async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("CloudSyncReviewDialog", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);

		getCloudSyncPreview.mockReset();
		onCloudSyncProgressChange.mockReset();
		getCloudSyncPreview.mockResolvedValue(PREVIEW);
		onCloudSyncProgressChange.mockImplementation(() =>
			Promise.resolve(() => {}),
		);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	async function renderDialog(
		onConfirm: (excluded: string[]) => void = () => {},
	) {
		await act(async () => {
			root.render(
				<CloudSyncReviewDialog
					open
					onOpenChange={() => {}}
					workspacePath={WORKSPACE_PATH}
					workspaceName="demo"
					deploymentUrl="http://127.0.0.1:8787"
					onConfirm={onConfirm}
				/>,
			);
			await flushMicrotasks();
		});
	}

	// The shared Modal portals to document.body, so queries target the body.
	function bodyText(): string {
		return document.body.textContent ?? "";
	}

	function checkboxFor(folder: string): HTMLInputElement {
		const input = document.body.querySelector(
			`input[aria-label="Sync ${folder}"]`,
		) as HTMLInputElement | null;
		if (!input) throw new Error(`no checkbox for ${folder}`);
		return input;
	}

	function clickButton(label: string) {
		const button = [...document.body.querySelectorAll("button")].find(
			(el) => el.textContent === label,
		);
		if (!button) throw new Error(`no button labelled "${label}"`);
		act(() => button.click());
	}

	it("asks the engine for a plan-backed preview (not a local estimate)", async () => {
		await renderDialog();
		expect(getCloudSyncPreview).toHaveBeenCalledWith(WORKSPACE_PATH, {
			workspaceName: "demo",
			deploymentUrl: "http://127.0.0.1:8787",
			password: undefined,
		});
	});

	it("shows plan counts and the engine reason on the greyed row", async () => {
		await renderDialog();
		expect(bodyText()).toContain("11 to sync");
		expect(bodyText()).toContain("vendor");
		// Engine reason, not a UI guess.
		expect(bodyText()).toContain("excluded — ignored");
		// Excluded row starts unchecked (greyed, re-includable).
		expect(checkboxFor("vendor").checked).toBe(false);
		expect(checkboxFor("docs").checked).toBe(true);
	});

	it("confirm returns unchecked folders as exclusions", async () => {
		const seen: string[][] = [];
		await renderDialog((excluded) => {
			seen.push(excluded);
		});
		clickButton("Enable sync");
		expect(seen).toEqual([["vendor"]]);
	});

	it("an excluded folder is re-includable by checking its box", async () => {
		const seen: string[][] = [];
		await renderDialog((excluded) => {
			seen.push(excluded);
		});
		act(() => checkboxFor("vendor").click());
		expect(checkboxFor("vendor").checked).toBe(true);
		clickButton("Enable sync");
		expect(seen).toEqual([[]]);
	});

	it("a plan row can be opted out by unchecking it", async () => {
		const seen: string[][] = [];
		await renderDialog((excluded) => {
			seen.push(excluded);
		});
		act(() => checkboxFor("docs").click());
		clickButton("Enable sync");
		expect(seen).toEqual([["docs", "vendor"]]);
	});

	it("surfaces a failed preview inline instead of an empty dialog", async () => {
		getCloudSyncPreview.mockRejectedValueOnce(new Error("workspace too large"));
		await renderDialog();
		expect(bodyText()).toContain("workspace too large");
	});
});
