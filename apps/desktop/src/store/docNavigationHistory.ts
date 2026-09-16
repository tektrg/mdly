import { store } from "@simplestack/store";
import { pathInFolder, replacePathPrefix } from "../lib/filePath";
import { workspacePathStore, workspaceStore } from "./state";

export type DocNavigationHistory = {
	back: string[];
	forward: string[];
	current: string | null;
};

export const MAX_NAV_HISTORY = 50;

/**
 * Stack entry standing for "the full-width document table", so closing a
 * document is a real back-stack step rather than a hole (R7).
 *
 * It is a URL-shaped string on purpose: every path-fixup helper here matches
 * either by exact equality (`updatePathInHistory`, `removePathFromHistory`) or
 * by an absolute `/`-prefixed folder prefix (`pathInFolder`, `replacePathPrefix`),
 * so a rename, folder move, or delete of a real document leaves this entry
 * untouched. `pushNavigation`/`navigateBack`/`navigateForward` need no changes:
 * they treat entries as opaque strings, and `pushNavigation` already no-ops on a
 * repeat of `current`.
 */
export const TABLE_NAV_ENTRY = "mdly://table";

export function createInitialHistory(
	current: string | null = null,
): DocNavigationHistory {
	return {
		back: [],
		forward: [],
		current,
	};
}

/**
 * Pushes a new path into the history stack, clearing the forward stack.
 * If the path is already the current path, history is unchanged.
 */
export function pushNavigation(
	history: DocNavigationHistory,
	nextPath: string,
): DocNavigationHistory {
	if (!nextPath || history.current === nextPath) {
		return history;
	}
	const back = history.current
		? [...history.back, history.current].slice(-MAX_NAV_HISTORY)
		: history.back;
	return {
		back,
		forward: [],
		current: nextPath,
	};
}

/**
 * Pops the previous document from the back stack, pushes current to forward stack,
 * and returns the target document path.
 */
export function navigateBack(
	history: DocNavigationHistory,
): { nextHistory: DocNavigationHistory; targetPath: string } | null {
	if (history.back.length === 0) return null;
	const nextBack = [...history.back];
	const targetPath = nextBack.pop();
	if (!targetPath) return null;
	const nextForward = history.current
		? [history.current, ...history.forward].slice(0, MAX_NAV_HISTORY)
		: history.forward;
	return {
		nextHistory: {
			back: nextBack,
			forward: nextForward,
			current: targetPath,
		},
		targetPath,
	};
}

/**
 * Pops the next document from the forward stack, pushes current to back stack,
 * and returns the target document path.
 */
export function navigateForward(
	history: DocNavigationHistory,
): { nextHistory: DocNavigationHistory; targetPath: string } | null {
	if (history.forward.length === 0) return null;
	const nextForward = [...history.forward];
	const targetPath = nextForward.shift();
	if (!targetPath) return null;
	const nextBack = history.current
		? [...history.back, history.current].slice(-MAX_NAV_HISTORY)
		: history.back;
	return {
		nextHistory: {
			back: nextBack,
			forward: nextForward,
			current: targetPath,
		},
		targetPath,
	};
}

/**
 * Replaces the current path without pushing to the back stack or clearing forward stack.
 * Useful when initializing or when the active document is renamed.
 */
export function replaceCurrentInHistory(
	history: DocNavigationHistory,
	nextPath: string,
): DocNavigationHistory {
	return {
		...history,
		current: nextPath,
	};
}

/**
 * Updates all occurrences of oldPath to newPath across back, forward, and current.
 */
export function updatePathInHistory(
	history: DocNavigationHistory,
	oldPath: string,
	newPath: string,
): DocNavigationHistory {
	const update = (p: string) => (p === oldPath ? newPath : p);
	return {
		back: history.back.map(update),
		forward: history.forward.map(update),
		current: history.current ? update(history.current) : null,
	};
}

/**
 * Updates paths with oldPrefix to newPrefix across back, forward, and current when a folder moves.
 */
export function updatePrefixInHistory(
	history: DocNavigationHistory,
	oldPrefix: string,
	newPrefix: string,
): DocNavigationHistory {
	const update = (p: string) => replacePathPrefix(p, oldPrefix, newPrefix);
	return {
		back: history.back.map(update),
		forward: history.forward.map(update),
		current: history.current ? update(history.current) : null,
	};
}

/**
 * Removes all occurrences of pathToRemove (and children if folder) from back and forward stacks.
 */
export function removePathFromHistory(
	history: DocNavigationHistory,
	pathToRemove: string,
): DocNavigationHistory {
	const shouldKeep = (p: string) =>
		p !== pathToRemove && !pathInFolder(p, pathToRemove);
	return {
		back: history.back.filter(shouldKeep),
		forward: history.forward.filter(shouldKeep),
		current:
			history.current && shouldKeep(history.current) ? history.current : null,
	};
}

// ── Workspace-Scoped History State ─────────────────────────────────────

const historiesByWorkspace = new Map<string, DocNavigationHistory>();

function getWorkspaceKey(workspacePath?: string | null): string {
	if (workspacePath !== undefined) return workspacePath ?? "";
	return workspaceStore.get().workspacePath ?? "";
}

export function getDocNavigationHistory(
	workspacePath?: string | null,
): DocNavigationHistory {
	const key = getWorkspaceKey(workspacePath);
	let history = historiesByWorkspace.get(key);
	if (!history) {
		history = createInitialHistory();
		historiesByWorkspace.set(key, history);
	}
	return history;
}

export function setDocNavigationHistory(
	history: DocNavigationHistory,
	workspacePath?: string | null,
) {
	const key = getWorkspaceKey(workspacePath);
	historiesByWorkspace.set(key, history);
	docNavigationStore.set(history);
}

export const docNavigationStore = store<DocNavigationHistory>(
	createInitialHistory(),
);

// Keep docNavigationStore in sync when switching workspaces
workspacePathStore.subscribe((workspacePath) => {
	const history = getDocNavigationHistory(workspacePath);
	docNavigationStore.set(history);
});

export function recordDocNavigation(
	path: string,
	options?: { replace?: boolean; workspacePath?: string | null },
) {
	const history = getDocNavigationHistory(options?.workspacePath);
	const nextHistory = options?.replace
		? replaceCurrentInHistory(history, path)
		: pushNavigation(history, path);
	setDocNavigationHistory(nextHistory, options?.workspacePath);
}

export function updateDocNavigationPath(oldPath: string, newPath: string) {
	for (const [key, history] of historiesByWorkspace.entries()) {
		const updated = updatePathInHistory(history, oldPath, newPath);
		historiesByWorkspace.set(key, updated);
		if (key === getWorkspaceKey()) {
			docNavigationStore.set(updated);
		}
	}
}

export function updateDocNavigationPrefix(
	oldPrefix: string,
	newPrefix: string,
) {
	for (const [key, history] of historiesByWorkspace.entries()) {
		const updated = updatePrefixInHistory(history, oldPrefix, newPrefix);
		historiesByWorkspace.set(key, updated);
		if (key === getWorkspaceKey()) {
			docNavigationStore.set(updated);
		}
	}
}

export function removeDocNavigationPath(pathToRemove: string) {
	for (const [key, history] of historiesByWorkspace.entries()) {
		const updated = removePathFromHistory(history, pathToRemove);
		historiesByWorkspace.set(key, updated);
		if (key === getWorkspaceKey()) {
			docNavigationStore.set(updated);
		}
	}
}

export function clearDocNavigationHistory() {
	historiesByWorkspace.clear();
	docNavigationStore.set(createInitialHistory());
}
