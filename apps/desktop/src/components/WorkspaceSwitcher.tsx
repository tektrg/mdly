import { WorkspaceSwitcherMenu } from "@mdly/workspace-kit";
import { useStoreValue } from "@simplestack/store/react";
import MingcuteAddLine from "~icons/mingcute/add-line";
import { openWorkspace, setWorkspaceSwitcherOpen } from "../store/actions";
import {
	recentWorkspacesStore,
	switcherOpenStore,
	workspacePathStore,
} from "../store/state";

function folderName(path: string): string {
	return path.split("/").pop() ?? path.split("\\").pop() ?? path;
}

function WorkspaceItemLabel({ name, path }: { name: string; path: string }) {
	const separator = path.includes("\\") ? "\\" : "/";
	const segments = path.split(separator);
	segments.pop();
	const parentPath = segments.length > 0 ? segments.join(separator) + separator : "";

	return (
		<span className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
			<span className="block truncate text-[11px] text-sidebar-foreground">{name}</span>
			<span className="flex min-w-0 text-[10px] leading-3.5 text-muted-foreground">
				<span className="min-w-0 truncate">{parentPath}</span>
				<span className="shrink-0 whitespace-nowrap">{name}</span>
			</span>
		</span>
	);
}

export function WorkspaceSwitcher() {
	const workspacePath = useStoreValue(workspacePathStore);
	const recentWorkspaces = useStoreValue(recentWorkspacesStore);
	const open = useStoreValue(switcherOpenStore);
	if (!workspacePath) return null;
	const workspaceName = folderName(workspacePath);
	const others = recentWorkspaces.filter((p) => p !== workspacePath);

	return (
		<WorkspaceSwitcherMenu
			label={workspaceName}
			title={workspacePath}
			open={open}
			onOpenChange={setWorkspaceSwitcherOpen}
		>
			<WorkspaceSwitcherMenu.Item selected title={workspacePath}>
				<WorkspaceItemLabel name={workspaceName} path={workspacePath} />
			</WorkspaceSwitcherMenu.Item>
			{others.map((path) => (
				<WorkspaceSwitcherMenu.Item
					key={path}
					title={path}
					onClick={() => void openWorkspace(path)}
				>
					<WorkspaceItemLabel name={folderName(path)} path={path} />
				</WorkspaceSwitcherMenu.Item>
			))}
			<WorkspaceSwitcherMenu.Item
				icon={<MingcuteAddLine className="size-3 shrink-0" />}
				onClick={() => void openWorkspace()}
			>
				Add folder...
			</WorkspaceSwitcherMenu.Item>
		</WorkspaceSwitcherMenu>
	);
}
