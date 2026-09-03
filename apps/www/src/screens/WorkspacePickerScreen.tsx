import { listWorkspaces, type WorkspaceSummary } from "@mdly/cloudflare-client";
import { useEffect, useState } from "react";
import { describeApiError, isUnauthorizedError } from "../connection/apiError";
import { saveWorkspace } from "../connection/connection";
import { WORKER_BASE_URL } from "../connection/workerUrl";

type Props = {
	onSelected: (id: string) => void;
	onUnauthorized: () => void;
	onLogout: () => void;
};

/**
 * Replaces the old Convex-era OpenWorkspaceScreen. Per D8b, only the desktop
 * app creates/enables a workspace — the web surface only ever picks among
 * whatever the Worker's `/api/workspaces` already lists, never creates one.
 */
export function WorkspacePickerScreen({
	onSelected,
	onUnauthorized,
	onLogout,
}: Props) {
	const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: select uses stable saveWorkspace + props
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
				if (result.length === 1) select(result[0]!.workspaceId);
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

	const select = (id: string) => {
		saveWorkspace(id);
		onSelected(id);
	};

	return (
		<main className="flex h-dvh items-center justify-center bg-background text-foreground">
			<div className="flex w-full max-w-md flex-col gap-3 rounded-md border border-border bg-sidebar p-6">
				<div className="flex items-start justify-between gap-3">
					<h1 className="m-0 text-base font-semibold">Open a Workspace</h1>
					<button
						type="button"
						onClick={onLogout}
						className="text-xs text-muted-foreground underline-offset-2 hover:underline"
					>
						Log out
					</button>
				</div>

				{error && (
					<p className="m-0 rounded-sm bg-muted px-2.5 py-1.5 text-xs text-destructive">
						{error}
					</p>
				)}

				{workspaces === null && !error && (
					<p className="m-0 text-xs text-muted-foreground">Loading…</p>
				)}

				{workspaces && workspaces.length === 0 && !error && (
					<p className="m-0 text-xs text-muted-foreground">
						No workspaces yet. Enable Cloud Sync from the desktop app first.
					</p>
				)}

				{workspaces && workspaces.length > 1 && (
					<ul className="m-0 flex flex-col gap-1 p-0">
						{workspaces.map((w) => (
							<li key={w.workspaceId} className="list-none">
								<button
									type="button"
									onClick={() => select(w.workspaceId)}
									className="block w-full rounded-sm border border-border bg-background px-3 py-2 text-left text-sm hover:bg-sidebar-accent"
								>
									{w.name}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		</main>
	);
}
