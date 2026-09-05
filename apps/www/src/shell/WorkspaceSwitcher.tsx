import { listWorkspaces, type WorkspaceSummary } from "@mdly/cloudflare-client";
import { WorkspaceSwitcherMenu } from "@mdly/workspace-kit";
import { useEffect, useState } from "react";
import { describeApiError, isUnauthorizedError } from "../connection/apiError";
import { WORKER_BASE_URL } from "../connection/workerUrl";

type Props = {
	currentWorkspaceId: string;
	currentWorkspaceName: string;
	onSelect: (id: string) => void;
	onUnauthorized: () => void;
	onLogout: () => void;
};

/**
 * D8: kept (not deleted like the other Convex-era screens), just repointed
 * at the Worker's authenticated /api/workspaces route. "Create workspace" is
 * gone — D8b reserves workspace creation for the desktop app.
 */
export function WorkspaceSwitcher({
	currentWorkspaceId,
	currentWorkspaceName,
	onSelect,
	onUnauthorized,
	onLogout,
}: Props) {
	const [open, setOpen] = useState(false);
	const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
	const [error, setError] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: onUnauthorized is a stable store setter
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const result = await listWorkspaces({
					baseUrl: WORKER_BASE_URL,
					auth: { kind: "cookie" },
				});
				if (cancelled) return;
				setWorkspaces(result);
			} catch (err) {
				if (cancelled) return;
				if (isUnauthorizedError(err)) {
					onUnauthorized();
					return;
				}
				setError(describeApiError(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<WorkspaceSwitcherMenu
			label={currentWorkspaceName}
			title={currentWorkspaceName}
			open={open}
			onOpenChange={setOpen}
		>
			{error && (
				<div className="px-2 py-1 text-[11px] text-destructive">{error}</div>
			)}
			{workspaces.map((workspace) => (
				<WorkspaceSwitcherMenu.Item
					key={workspace.workspaceId}
					selected={workspace.workspaceId === currentWorkspaceId}
					onClick={() => {
						setOpen(false);
						if (workspace.workspaceId !== currentWorkspaceId) {
							onSelect(workspace.workspaceId);
						}
					}}
				>
					<span className="truncate">{workspace.name}</span>
				</WorkspaceSwitcherMenu.Item>
			))}
			<WorkspaceSwitcherMenu.Separator />
			<WorkspaceSwitcherMenu.Item
				onClick={() => {
					setOpen(false);
					onLogout();
				}}
			>
				Log out
			</WorkspaceSwitcherMenu.Item>
		</WorkspaceSwitcherMenu>
	);
}
