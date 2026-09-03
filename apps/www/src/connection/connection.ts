/**
 * D6 dropped the old "connect to an arbitrary Convex deployment URL" concept
 * entirely — apps/www always talks to its own same-origin Worker (see
 * workerUrl.ts). The only thing left to persist client-side is which
 * workspace was last open, purely as a convenience for the "/" route.
 */
const WORKSPACE_ID_KEY = "hubble.connection.workspaceId";

export function readLastWorkspaceId(): string | null {
	return localStorage.getItem(WORKSPACE_ID_KEY);
}

export function saveWorkspace(id: string): void {
	localStorage.setItem(WORKSPACE_ID_KEY, id);
}

export function clearWorkspace(): void {
	localStorage.removeItem(WORKSPACE_ID_KEY);
}
