import { store } from "@simplestack/store";

/**
 * Global "are we logged in" gate (D6/D8 — login screen replaces the old
 * Convex ConnectScreen). Starts optimistic: a returning visitor likely still
 * has a valid 30-day session cookie, so we render the app immediately rather
 * than blocking on an extra round trip just to check. Whichever fetch runs
 * first (WorkspacePickerScreen's listWorkspaces, or AppShell's workspace
 * snapshot load) flips this to "unauthenticated" the moment it sees a 401,
 * which is all `AppGate` needs to swap in the login screen.
 */
export type AuthStatus = "authenticated" | "unauthenticated";

export const authStore = store<AuthStatus>("authenticated");

export function markAuthenticated(): void {
	authStore.set("authenticated");
}

export function markUnauthenticated(): void {
	authStore.set("unauthenticated");
}
