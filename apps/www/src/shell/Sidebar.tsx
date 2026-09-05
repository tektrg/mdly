import { Sidebar as SharedSidebar } from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import { useState } from "react";
import {
	currentPathStore,
	filesLoadedStore,
	filesStore,
	pendingPathStore,
} from "../store/state";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

export function Sidebar({
	workspaceId,
	workspaceName,
	onSelectFile,
	onSwitch,
	onUnauthorized,
	onLogout,
}: {
	workspaceId: string;
	workspaceName: string;
	onSelectFile: (path: string) => void;
	onSwitch: (id: string) => void;
	onUnauthorized: () => void;
	onLogout: () => void;
}) {
	const files = useStoreValue(filesStore);
	const filesLoaded = useStoreValue(filesLoadedStore);
	const currentPath = useStoreValue(currentPathStore);
	const pendingPath = useStoreValue(pendingPathStore);
	const [sortMode, setSortMode] = useState<"alpha" | "recent">("recent");

	return (
		<SharedSidebar
			files={files.map((file) => ({
				path: file.path,
				modifiedAt: file.updatedAt,
			}))}
			currentPath={currentPath ?? null}
			pendingPath={pendingPath}
			sortMode={sortMode}
			storageScope={workspaceId}
			header={
				<WorkspaceSwitcher
					currentWorkspaceId={workspaceId}
					currentWorkspaceName={workspaceName}
					onSelect={onSwitch}
					onUnauthorized={onUnauthorized}
					onLogout={onLogout}
				/>
			}
			onSortModeChange={setSortMode}
			onSelectFile={onSelectFile}
			emptyState={
				filesLoaded ? (
					<p className="px-2.5 py-2 text-xs text-muted-foreground">
						This workspace has no notes yet.
					</p>
				) : null
			}
		/>
	);
}
