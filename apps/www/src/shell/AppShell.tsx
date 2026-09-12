import { AppShellFrame } from "@hubble.md/ui";
import { createCloudflareSubscriber } from "@mdly/cloudflare-client";
import { useStoreValue } from "@simplestack/store/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isUnauthorizedError } from "../connection/apiError";
import { saveWorkspace } from "../connection/connection";
import { WORKER_BASE_URL } from "../connection/workerUrl";
import {
	applyRemoteChange,
	checkWorkspaceAvailable,
	clearCurrentPath,
	getActionCtx,
	loadPath,
	loadWorkspaceSnapshot,
	markRemoteDeleted,
	refreshAssets,
	teardownActions,
} from "../store/actions";
import { isSidecarRow, sidecarsChanged, toSidecarMap } from "../store/sidecars";
import { viewerStore, workspaceStore } from "../store/state";
import { EditorView } from "./EditorView";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";

// R36: how often a browser holding a workspace open re-checks that the
// workspace is still opted into cloud sync. See checkWorkspaceAvailable's
// doc comment (store/actions.ts) for why polling, not a push signal, is
// what's available here.
const WORKSPACE_AVAILABILITY_POLL_MS = 5000;

/**
 * Notification-driven resync debounce (DO row-read frequency fix, 2c):
 * broadcasts from a multi-device write burst collapse into one refresh.
 * Well under the desktop leg's 5s max-wait; the in-flight guard below is
 * what stops overlapping refreshes stacking on a slow listing.
 */
const REMOTE_RESYNC_DEBOUNCE_MS = 400;

type Props = {
	workspaceId: string;
	filePath: string | null;
	onSelectFile: (path: string) => void;
	onSwitch: (id: string) => void;
	onUnauthorized: () => void;
	onLogout: () => void;
};

export function AppShell({
	workspaceId,
	filePath,
	onSelectFile,
	onSwitch,
	onUnauthorized,
	onLogout,
}: Props) {
	const viewer = useStoreValue(viewerStore);
	const workspace = useStoreValue(workspaceStore);
	const [mobileNavOpen, setMobileNavOpen] = useState(false);
	const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
	const selectFile = useCallback(
		(path: string) => {
			onSelectFile(path);
			closeMobileNav();
		},
		[onSelectFile, closeMobileNav],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: snapshot reloads only when workspace identity changes; file route changes load below
	useEffect(() => {
		void loadWorkspaceSnapshot(workspaceId, filePath).then((result) => {
			if (result === "unauthorized") {
				onUnauthorized();
				return;
			}
			if (result !== "loaded") return;
			saveWorkspace(workspaceId);
		});
	}, [workspaceId]);

	useEffect(() => {
		if (workspace.snapshot?.id !== workspaceId) return;
		if (filePath) {
			if (viewerStore.get().currentPath !== filePath) void loadPath(filePath);
			return;
		}
		clearCurrentPath();
	}, [filePath, workspace.snapshot?.id, workspaceId]);

	useEffect(() => {
		return () => {
			teardownActions();
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: subscription owns its lifecycle by workspace snapshot identity
	useEffect(() => {
		if (!workspace.snapshot) return;
		// New workspace, new version counter (2d): counters are
		// per-workspace, so a version remembered from the previous workspace
		// must never suppress this one's first refresh.
		lastSeenVersion.current = null;
		const snapshotId = workspace.snapshot.id;
		// Shared self-echo ledger (2b): the SAME object the backend in the
		// action context records its mutation versions into — constructed
		// together in store/actions.ts's createCtx. Only shared when the
		// context actually belongs to this snapshot: version counters are
		// per-workspace, and a cross-workspace ledger could suppress another
		// workspace's change that happens to share a version number.
		const actionCtx = getActionCtx();
		const versionLedger =
			actionCtx && actionCtx.workspaceId === snapshotId
				? actionCtx.versionLedger
				: undefined;
		const subscriber = createCloudflareSubscriber({
			baseUrl: WORKER_BASE_URL,
			auth: { kind: "cookie" },
			versionLedger,
		});
		const unsubscribe = subscriber.onFilesChanged(
			snapshotId,
			() => {
				scheduleRemoteResync();
			},
			(err) => {
				console.error("subscription error:", err);
			},
		);
		const unsubscribeAssets = subscriber.onAssetsChanged(
			snapshotId,
			() => {
				void refreshAssets();
			},
			(err) => {
				console.error("asset subscription error:", err);
			},
		);
		return () => {
			if (resyncTimer.current !== null) {
				window.clearTimeout(resyncTimer.current);
				resyncTimer.current = null;
			}
			// A refresh queued behind an in-flight one must not fire after
			// teardown into a different workspace's state.
			resyncQueued.current = false;
			unsubscribe();
			unsubscribeAssets();
			void subscriber.close();
		};
	}, [workspace.snapshot]);

	// R36: no push signal exists for "this workspace's sync was turned off" —
	// poll instead. Dropping `workspace.snapshot` to null on "unavailable" is
	// what actually tears the subscription down (its effect above is keyed on
	// snapshot identity) and swaps in the early-return loading/error screen
	// below with a clear message, rather than leaving the socket open and
	// inert.
	// biome-ignore lint/correctness/useExhaustiveDependencies: polls by workspace identity only; onUnauthorized is a stable store setter
	useEffect(() => {
		const interval = window.setInterval(() => {
			void checkWorkspaceAvailable(workspaceId).then((availability) => {
				if (workspaceStore.get().snapshot?.id !== workspaceId) return;
				if (availability === "unauthorized") {
					onUnauthorized();
					return;
				}
				if (availability !== "unavailable") return;
				workspaceStore.set((state) => ({
					...state,
					snapshot: null,
					status: "error",
					error: "This workspace's cloud sync was turned off.",
				}));
			});
		}, WORKSPACE_AVAILABILITY_POLL_MS);
		return () => window.clearInterval(interval);
	}, [workspaceId]);

	// Version this tab's view corresponds to (2d pre-check state), plus the
	// debounce timer and in-flight guard for notification-driven refreshes
	// (2c). Refs, not state: none of this renders, and the subscriber
	// callback closes over the first render's instances — refs stay correct
	// across renders where state snapshots would go stale.
	const lastSeenVersion = useRef<number | null>(null);
	const resyncTimer = useRef<number | null>(null);
	const resyncInFlight = useRef(false);
	const resyncQueued = useRef(false);

	const scheduleRemoteResync = () => {
		if (resyncTimer.current !== null) {
			window.clearTimeout(resyncTimer.current);
		}
		resyncTimer.current = window.setTimeout(() => {
			resyncTimer.current = null;
			void runRemoteResync();
		}, REMOTE_RESYNC_DEBOUNCE_MS);
	};

	const runRemoteResync = async () => {
		// In-flight guard (2c): a slow listing must never stack overlapping
		// refreshes — a broadcast arriving mid-refresh re-runs once after,
		// never concurrently.
		if (resyncInFlight.current) {
			resyncQueued.current = true;
			return;
		}
		resyncInFlight.current = true;
		try {
			await onRemoteFilesChanged();
		} finally {
			resyncInFlight.current = false;
			if (resyncQueued.current) {
				resyncQueued.current = false;
				void runRemoteResync();
			}
		}
	};

	const onRemoteFilesChanged = async () => {
		const ctx = getActionCtx();
		if (!ctx) return;
		try {
			// Cheap 1-row pre-check (2d): skip the full listing when the
			// version hasn't moved since this tab last refreshed (notably
			// the server's per-heartbeat ping-echo on an idle workspace).
			// The version is recorded only AFTER a successful listing, so a
			// change landing mid-refresh costs at most one redundant
			// listing — never a missed one. Backends without getVersion
			// (older servers, tests) list unconditionally, like before.
			let checkedVersion: number | undefined;
			if (ctx.backend.getVersion) {
				checkedVersion = await ctx.backend.getVersion(ctx.workspaceId);
				if (
					lastSeenVersion.current !== null &&
					checkedVersion === lastSeenVersion.current
				) {
					return;
				}
			}
			const remote = await ctx.backend.getFiles(ctx.workspaceId, {
				includeDeleted: true,
			});
			// One tombstone-inclusive fetch updates the sidebar and detects whether
			// the current file was deleted. Sidecar rows partition into their
			// own map (with content) and stay out of `files` — same split as
			// the snapshot and refresh paths, so all three always agree.
			const visible = remote
				.filter((f) => !f.deleted && !isSidecarRow(f.path))
				.map((f) => ({
					path: f.path,
					contentHash: f.contentHash,
					updatedAt: f.updatedAt,
					deleted: f.deleted,
				}));
			const sidecars = toSidecarMap(remote);
			workspaceStore.set((state) => ({
				...state,
				files: visible,
				sidecars,
				commentsVersion: sidecarsChanged(state.sidecars, sidecars)
					? state.commentsVersion + 1
					: state.commentsVersion,
			}));
			if (checkedVersion !== undefined) {
				lastSeenVersion.current = checkedVersion;
			}

			const v = viewerStore.get();
			if (!v.currentPath) return;
			const current = remote.find((f) => f.path === v.currentPath);
			if (!current || current.deleted) {
				markRemoteDeleted(v.currentPath);
				return;
			}
			applyRemoteChange(v.currentPath, current.content, current.contentHash);
		} catch (err) {
			if (isUnauthorizedError(err)) {
				onUnauthorized();
				return;
			}
			console.error("onRemoteFilesChanged failed:", err);
		}
	};

	if (!workspace.snapshot) {
		return (
			<main className="flex h-dvh items-center justify-center bg-background text-foreground">
				<p className="text-sm text-muted-foreground">
					{workspace.status === "error"
						? (workspace.error ?? "Workspace failed to load")
						: "Loading workspace…"}
				</p>
			</main>
		);
	}

	return (
		<AppShellFrame
			sidebar={
				<Sidebar
					workspaceId={workspace.snapshot.id}
					workspaceName={workspace.snapshot.name}
					onSelectFile={selectFile}
					onSwitch={onSwitch}
					onUnauthorized={onUnauthorized}
					onLogout={onLogout}
				/>
			}
			toolbar={<Toolbar onOpenMobileNav={() => setMobileNavOpen(true)} />}
			mobileNavOpen={mobileNavOpen}
			onCloseMobileNav={closeMobileNav}
		>
			{workspace.status === "error" && workspace.error && (
				<ExternalChangeBanner
					message={workspace.error}
					onReload={() => {
						void loadWorkspaceSnapshot(workspaceId, filePath).then((result) => {
							if (result === "unauthorized") onUnauthorized();
						});
					}}
				/>
			)}
			{viewer.currentPath && (
				<div className="flex h-full min-h-0 flex-col">
					{viewer.externalChange.kind === "deleted" && (
						<ExternalChangeBanner
							message="This file was deleted remotely. Reload before editing."
							onReload={() => {
								if (viewer.currentPath) void loadPath(viewer.currentPath);
							}}
						/>
					)}
					<EditorView
						path={viewer.currentPath}
						initialMarkdown={viewer.content}
					/>
				</div>
			)}
			{!viewer.currentPath && viewer.status === "loading" && (
				<p className="p-6 text-sm text-muted-foreground">Loading…</p>
			)}
			{!viewer.currentPath && viewer.status === "error" && (
				<p className="p-6 text-sm text-destructive">{viewer.error}</p>
			)}
			{!viewer.currentPath &&
				viewer.status !== "loading" &&
				viewer.status !== "error" &&
				workspace.filesLoaded &&
				workspace.files.length === 0 && (
					<div
						className="flex h-full items-center justify-center p-6"
						data-testid="empty-workspace"
					>
						<p className="text-sm text-muted-foreground">
							This workspace has no notes yet.
						</p>
					</div>
				)}
			{!viewer.currentPath &&
				viewer.status !== "loading" &&
				viewer.status !== "error" &&
				workspace.filesLoaded &&
				workspace.files.length > 0 && (
					<div className="flex h-full items-center justify-center p-6">
						<p className="text-sm text-muted-foreground">
							Select a file to view its contents.
						</p>
					</div>
				)}
		</AppShellFrame>
	);
}

function ExternalChangeBanner({
	message,
	onReload,
}: {
	message: string;
	onReload: () => void;
}) {
	return (
		<div className="border-b border-border bg-muted/40">
			<div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
				<p className="m-0 text-sm text-muted-foreground">{message}</p>
				<button
					type="button"
					onClick={onReload}
					className="rounded-sm border border-border bg-background px-3 py-1 text-xs hover:bg-sidebar-accent"
				>
					Reload
				</button>
			</div>
		</div>
	);
}
