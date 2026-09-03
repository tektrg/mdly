// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CloudSyncStatus,
	CloudSyncWorkspaceState,
} from "../desktopApi/types";
import { CloudSyncSettings } from "./SettingsDialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const {
	getCloudSyncState,
	onCloudSyncStatusChange,
	enableCloudSync,
	disableCloudSync,
	setCloudSyncExcludedFolders,
} = vi.hoisted(() => ({
	getCloudSyncState: vi.fn(),
	onCloudSyncStatusChange: vi.fn(),
	enableCloudSync: vi.fn(),
	disableCloudSync: vi.fn(),
	setCloudSyncExcludedFolders: vi.fn(),
}));

vi.mock("../desktopApi", () => ({
	desktopApi: {
		getCloudSyncState,
		onCloudSyncStatusChange,
		enableCloudSync,
		disableCloudSync,
		setCloudSyncExcludedFolders,
	},
}));

const WORKSPACE_PATH = "/workspace/demo";

const SYNCED_ON_STATE: CloudSyncWorkspaceState = {
	backgroundSync: true,
	status: "idle",
	workspaceId: "workspace-1",
	deploymentUrl: "http://127.0.0.1:8787",
	detail: null,
	excludedFolders: [".git", "node_modules", ".claude"],
};

// Mirrors `DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES` in
// `apps/desktop/electron/cloudSyncWiring.ts`, which is what "Reset to
// defaults" types into the box.
const DEFAULT_EXCLUDED_FOLDER_LINES = [
	".git",
	"node_modules",
	"dist",
	".dev-electron",
	".hubble",
	".mdly",
	".claude",
].join("\n");

// The exact reason cloudSyncWiring.ts pushes through the status channel when
// the cloud-copy delete fails on disable (offline, rotated password).
const CLOUD_COPY_NOT_REMOVED_DETAIL =
	"Cloud sync is off, but the cloud copy has not been removed yet — this will retry automatically";

async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("CloudSyncSettings", () => {
	let container: HTMLDivElement;
	let root: Root;
	let statusCallback:
		| ((status: CloudSyncStatus, detail: string | null) => void)
		| undefined;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);

		statusCallback = undefined;
		getCloudSyncState.mockReset();
		onCloudSyncStatusChange.mockReset();
		enableCloudSync.mockReset();
		disableCloudSync.mockReset();
		setCloudSyncExcludedFolders.mockReset();

		getCloudSyncState.mockResolvedValue(SYNCED_ON_STATE);
		onCloudSyncStatusChange.mockImplementation(
			(_workspacePath: string, callback: typeof statusCallback) => {
				statusCallback = callback;
				return Promise.resolve(() => {});
			},
		);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function clickButton(label: string) {
		const button = [...container.querySelectorAll("button")].find(
			(el) => el.textContent === label,
		);
		act(() => button?.click());
	}

	// Reads the status/detail line specifically (sibling of the "Sync this
	// workspace to the cloud" label) rather than the whole container's text,
	// so this can't be confused with the unrelated static copy elsewhere in
	// the section ("Off by default per workspace.").
	function statusLineText(): string {
		const label = [...container.querySelectorAll("span")].find(
			(el) => el.textContent === "Sync this workspace to the cloud",
		);
		return label?.nextElementSibling?.textContent ?? "";
	}

	async function renderSettings() {
		await act(async () => {
			root.render(<CloudSyncSettings workspacePath={WORKSPACE_PATH} />);
			await flushMicrotasks();
		});
	}

	it("keeps the error visible instead of claiming the workspace is off when the cloud-copy delete fails", async () => {
		// The status-channel event lands before the disableCloudSync invoke
		// resolves in production (cloudSyncWiring pushes it synchronously on
		// failure, ahead of the IPC round trip settling) -- this deferred
		// promise lets the test reproduce that exact ordering.
		let resolveDisable!: (value: { cloudCopyDeleted: boolean }) => void;
		disableCloudSync.mockImplementation(
			() =>
				new Promise<{ cloudCopyDeleted: boolean }>((resolve) => {
					resolveDisable = resolve;
				}),
		);

		await renderSettings();
		expect(statusCallback).toBeTruthy();

		clickButton("Disable");

		// 1. The honest error status event arrives first.
		act(() => {
			statusCallback?.("error", CLOUD_COPY_NOT_REMOVED_DETAIL);
		});
		expect(statusLineText()).toBe(`Error — ${CLOUD_COPY_NOT_REMOVED_DETAIL}`);

		// 2. Only afterwards does the disableCloudSync call resolve, reporting
		// the delete failed.
		await act(async () => {
			resolveDisable({ cloudCopyDeleted: false });
			await flushMicrotasks();
		});

		// The UI must still show the error, not silently flip to "Off" as if
		// the cloud copy had been removed.
		expect(statusLineText()).toBe(`Error — ${CLOUD_COPY_NOT_REMOVED_DETAIL}`);
	});

	it("shows the workspace as off once the cloud copy is actually deleted", async () => {
		disableCloudSync.mockResolvedValue({ cloudCopyDeleted: true });

		await renderSettings();

		await act(async () => {
			clickButton("Disable");
			await flushMicrotasks();
		});

		expect(statusLineText()).toBe("Off");
	});
});

describe("CloudSyncSettings — folders never synced", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);

		getCloudSyncState.mockReset();
		onCloudSyncStatusChange.mockReset();
		enableCloudSync.mockReset();
		disableCloudSync.mockReset();
		setCloudSyncExcludedFolders.mockReset();

		getCloudSyncState.mockResolvedValue(SYNCED_ON_STATE);
		onCloudSyncStatusChange.mockImplementation(() => Promise.resolve(() => {}));
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function textarea(): HTMLTextAreaElement {
		const el = container.querySelector("textarea");
		if (!el) throw new Error("no excluded-folders textarea rendered");
		return el;
	}

	function clickButton(label: string) {
		const button = [...container.querySelectorAll("button")].find(
			(el) => el.textContent === label,
		);
		if (!button) throw new Error(`no button labelled "${label}"`);
		act(() => button.click());
	}

	// React installs its own `value` setter on the DOM node, so assigning
	// `.value` directly would not reach the component -- go through the native
	// prototype setter and fire the input event React actually listens for.
	function typeIntoTextarea(value: string) {
		const el = textarea();
		const nativeSetter = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set;
		act(() => {
			nativeSetter?.call(el, value);
			el.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	async function renderSettings(
		state: CloudSyncWorkspaceState = SYNCED_ON_STATE,
	) {
		getCloudSyncState.mockResolvedValue(state);
		await act(async () => {
			root.render(<CloudSyncSettings workspacePath={WORKSPACE_PATH} />);
			await flushMicrotasks();
		});
	}

	it("renders the effective list one folder name per line", async () => {
		await renderSettings();
		expect(textarea().value).toBe(".git\nnode_modules\n.claude");
	});

	it("stays visible while cloud sync is off — the list is worth setting before turning sync on", async () => {
		await renderSettings({
			...SYNCED_ON_STATE,
			backgroundSync: false,
			status: "off",
		});
		expect(textarea().value).toBe(".git\nnode_modules\n.claude");
	});

	it("Reset to defaults restores the built-in list", async () => {
		await renderSettings();
		clickButton("Reset to defaults");
		expect(textarea().value).toBe(DEFAULT_EXCLUDED_FOLDER_LINES);
	});

	it("saves the edited list and adopts whatever the main process reports back as effective", async () => {
		setCloudSyncExcludedFolders.mockResolvedValue({
			...SYNCED_ON_STATE,
			excludedFolders: [".claude", "vendor"],
		});
		await renderSettings();

		typeIntoTextarea(" .claude \n\nvendor\n.claude");
		await act(async () => {
			clickButton("Save folder list");
			await flushMicrotasks();
		});

		expect(setCloudSyncExcludedFolders).toHaveBeenCalledWith(WORKSPACE_PATH, [
			" .claude ",
			"",
			"vendor",
			".claude",
		]);
		expect(textarea().value).toBe(".claude\nvendor");
	});

	it("surfaces a rejected entry inline and leaves the saved list untouched", async () => {
		setCloudSyncExcludedFolders.mockRejectedValue(
			new Error(
				'"notes/drafts" looks like a path. List folder NAMES only — each name is matched at any depth inside the workspace.',
			),
		);
		await renderSettings();

		typeIntoTextarea(".claude\nnotes/drafts");
		await act(async () => {
			clickButton("Save folder list");
			await flushMicrotasks();
		});

		expect(container.textContent).toContain("List folder NAMES only");
		// The rejected draft is kept for the user to correct, and nothing claims
		// the new list took effect.
		expect(textarea().value).toBe(".claude\nnotes/drafts");
		expect(setCloudSyncExcludedFolders).toHaveBeenCalledTimes(1);
	});

	it("warns, without blocking, when the saved list is empty", async () => {
		await renderSettings({ ...SYNCED_ON_STATE, excludedFolders: [] });
		expect(container.textContent).toContain("Nothing is excluded");
	});
});
