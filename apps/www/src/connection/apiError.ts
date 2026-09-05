import {
	CloudflareResponseError,
	CloudflareValidationError,
} from "@mdly/cloudflare-client";

/**
 * Replaces the old Convex-era `convex-error.ts`. Convex's error surface
 * (missing-function / validator-rejected calls) doesn't apply to a plain
 * REST Worker — the only distinctions that matter here are: a session
 * that's no longer valid (401, handled separately via
 * `isUnauthorizedError`), a well-formed error the Worker sent on purpose
 * (`CloudflareResponseError`), a response that didn't match what we expected
 * (`CloudflareValidationError`), and everything else (network failure, bug).
 */
export function isUnauthorizedError(err: unknown): boolean {
	return err instanceof CloudflareResponseError && err.status === 401;
}

export function describeApiError(err: unknown): string {
	if (err instanceof CloudflareValidationError) {
		return "The server sent back something unexpected. Try reloading.";
	}
	if (err instanceof CloudflareResponseError) {
		if (err.status === 401) return "Your session expired. Please log in again.";
		if (err.status === 403) return "That action isn't allowed right now.";
		if (err.status === 413) return "Workspace storage limit reached.";
		if (err.status === 0)
			return "Couldn't reach the server. Check your connection.";
		return err.message || `Request failed (${err.status}).`;
	}
	return err instanceof Error ? err.message : String(err);
}
