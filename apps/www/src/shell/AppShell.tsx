import { AppShellFrame } from "@hubble.md/ui";
import { createCloudflareSubscriber } from "@mdly/cloudflare-client";
import { useStoreValue } from "@simplestack/store/react";
import { useEffect } from "react";
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
import { viewerStore, workspaceStore } from "../store/state";
import { EditorView } from "./EditorView";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";

// R36: how often a browser holding a workspace open re-checks that the
// workspace is still opted into cloud sync. See checkWorkspaceAvailable's
// doc comment (store/actions.ts) for why polling, not a push signal, is
// what's available here.
const WORKSPACE_AVAILABILITY_POLL_MS = 5000;

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
		const subscriber = createCloudflareSubscriber({
			baseUrl: WORKER_BASE_URL,
			auth: { kind: "cookie" },
		});
		const unsubscribe = subscriber.onFilesChanged(
			workspace.snapshot.id,
			() => {
				void onRemoteFilesChanged();
			},
			(err) => {
				console.error("subscription error:", err);
			},
		);
		const unsubscribeAssets = subscriber.onAssetsChanged(
			workspace.snapshot.id,
			() => {
				void refreshAssets();
			},
			(err) => {
				console.error("asset subscription error:", err);
			},
		);
		return () => {
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

	const onRemoteFilesChanged = async () => {
		const ctx = getActionCtx();
		if (!ctx) return;
		try {
			const remote = await ctx.backend.getFiles(ctx.workspaceId, {
				includeDeleted: true,
			});
			// One tombstone-inclusive fetch updates the sidebar and detects whether
			// the current file was deleted.
			const visible = remote
				.filter((f) => !f.deleted)
				.map((f) => ({
					path: f.path,
					contentHash: f.contentHash,
					updatedAt: f.updatedAt,
					deleted: f.deleted,
				}));
			workspaceStore.set((state) => ({ ...state, files: visible }));

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
					onSelectFile={onSelectFile}
					onSwitch={onSwitch}
					onUnauthorized={onUnauthorized}
					onLogout={onLogout}
				/>
			}
			toolbar={<Toolbar />}
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
