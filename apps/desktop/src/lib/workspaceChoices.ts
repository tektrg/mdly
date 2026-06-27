export type WorkspaceChoice =
	| {
			kind: "workspace";
			path: string;
			label: string;
			detail: string;
			current: boolean;
	  }
	| {
			kind: "add-folder";
			label: string;
			detail: string;
	  };

export type BuildWorkspaceChoicesOptions = {
	workspacePath: string | null | undefined;
	recentWorkspaces: readonly string[];
	query: string;
	limit?: number;
};

const addFolderChoice: WorkspaceChoice = {
	kind: "add-folder",
	label: "Add folder...",
	detail: "Choose another folder to open",
};

export function workspaceFolderName(path: string): string {
	return path.split("/").pop() ?? path.split("\\").pop() ?? path;
}

export function buildWorkspaceChoices({
	workspacePath,
	recentWorkspaces,
	query,
	limit = 20,
}: BuildWorkspaceChoicesOptions): WorkspaceChoice[] {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const workspaceChoices: WorkspaceChoice[] = [];
	const seenPaths = new Set<string>();
	const maxWorkspaceChoices = Math.max(0, limit);

	function addWorkspace(path: string, current: boolean) {
		if (seenPaths.has(path)) {
			return;
		}
		seenPaths.add(path);

		const label = workspaceFolderName(path);
		if (
			workspaceChoices.length >= maxWorkspaceChoices ||
			!matchesQuery(label, path, normalizedQuery)
		) {
			return;
		}

		workspaceChoices.push({
			kind: "workspace",
			path,
			label,
			detail: path,
			current,
		});
	}

	if (workspacePath) {
		addWorkspace(workspacePath, true);
	}
	for (const path of recentWorkspaces) {
		addWorkspace(path, false);
	}

	return [...workspaceChoices, addFolderChoice];
}

function matchesQuery(label: string, path: string, normalizedQuery: string) {
	if (!normalizedQuery) return true;
	return (
		label.toLocaleLowerCase().includes(normalizedQuery) ||
		path.toLocaleLowerCase().includes(normalizedQuery)
	);
}
