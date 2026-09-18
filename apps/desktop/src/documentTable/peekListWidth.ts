import { workspaceStore } from "../store/state";

/**
 * R13: the peek list's desired width, per workspace. Matches the `w-64` the
 * narrow list used before it became resizable, so first paint after the
 * migration reads exactly as before.
 */
export const PEEK_LIST_DEFAULT_WIDTH = 256;

function sanitizeWidth(width: unknown): number | null {
	if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
		return null;
	}
	return width;
}

/**
 * Reads the persisted desire for a workspace. Unknown workspaces and corrupt
 * entries fall back to the default — a missing record is "never resized", not
 * an error.
 */
export function getPeekListDesiredWidth(workspacePath: string | null): number {
	if (!workspacePath) return PEEK_LIST_DEFAULT_WIDTH;
	const stored = workspaceStore.get().peekListWidths[workspacePath];
	return sanitizeWidth(stored) ?? PEEK_LIST_DEFAULT_WIDTH;
}

/**
 * Persists the user's drag choice. Written through the same `workspaceStore`
 * (and its `localStoragePersist` middleware) as every other workspace
 * preference — `serialize` carries it, so there is no second mechanism.
 * Render-time clamping stays the caller's job: this stores the DESIRE.
 */
export function setPeekListDesiredWidth(
	workspacePath: string | null,
	width: number,
): void {
	if (!workspacePath) return;
	const next = sanitizeWidth(width);
	if (next === null) return;
	workspaceStore.set((state) => ({
		...state,
		peekListWidths: { ...state.peekListWidths, [workspacePath]: next },
	}));
}
