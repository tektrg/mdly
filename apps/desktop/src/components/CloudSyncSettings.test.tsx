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
	onCloudSyncProgressChange,
	enableCloudSync,
	disableCloudSync,
	setCloudSyncExcludedFolders,
	getCloudSyncPreview,
	approveCloudSyncPendingFolder,
	excludeCloudSyncPendingFolder,
} = vi.hoisted(() => ({
	getCloudSyncState: vi.fn(),
	onCloudSyncStatusChange: vi.fn(),
	onCloudSyncProgressChange: vi.fn(),
	enableCloudSync: vi.fn(),
	disableCloudSync: vi.fn(),
	setCloudSyncExcludedFolders: vi.fn(),
	getCloudSyncPreview: vi.fn(),
	approveCloudSyncPendingFolder: vi.fn(),
	excludeCloudSyncPendingFolder: vi.fn(),
}));

vi.mock("../desktopApi", () => ({
	desktopApi: {
		getCloudSyncState,
		onCloudSyncStatusChange,
		onCloudSyncProgressChange,
		enableCloudSync,
		disableCloudSync,
		setCloudSyncExcludedFolders,
		getCloudSyncPreview,
		approveCloudSyncPendingFolder,
		excludeCloudSyncPendingFolder,
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
	pendingFolders: [],
	progress: null,
};

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
		onCloudSyncProgressChange.mockReset();
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
		onCloudSyncProgressChange.mockImplementation(() =>
			Promise.resolve(() => {}),
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
