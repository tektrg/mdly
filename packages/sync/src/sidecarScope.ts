/**
 * Step 1 fence (codename tombstone-then-403-fence): keeps hidden `.mdly`
 * sidecar rows out of the note/asset sync paths.
 *
 * WHY: a remote `.mdly/comments/x 2.jsonl` row gets pulled, then on the next
 * run looks locally deleted because both walkers prune `.mdly`, then
 * `execute()` calls `backend.softDeleteFile` with no try/catch, the worker
 * slot invariant returns 403, and desktop sync dies permanently. The fence
 * below makes such rows cause zero ops instead.
 *
 * Scope split (deliberate, two widths):
 * - `isSidecarPath` (BROAD fence): anything under `.mdly/`. This is what the
 *   sync loop wires in — every remote `.mdly` row is ignored, so no current
 *   or future sidecar kind can ever become a fatal tombstone op.
 * - `isSyncedSidecarPath` (NARROW allowlist): only
 *   `.mdly/comments/**\/*.jsonl` + `.mdly/history/index*.jsonl`. Revision
 *   blobs (`.mdly/history/objects/**`) never leave the Mac. Wired in Step 3,
 *   not yet.
 */

/** Every sidecar path lives under this workspace-relative prefix. */
export const SIDECAR_PREFIX = ".mdly/";

/**
 * Broad fence predicate: true for any path inside `.mdly/` (plus the bare
 * `.mdly` dir entry itself). Case-sensitive — matches the walkers' pruning,
 * which compares the exact folder name `.mdly`.
 */
export function isSidecarPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	return normalized === ".mdly" || normalized.startsWith(SIDECAR_PREFIX);
}

/** Workspace-relative prefix for per-document comment logs. */
const COMMENTS_PREFIX = ".mdly/comments/";

/** Workspace-relative prefix for the note path→id map shards. */
const HISTORY_PREFIX = ".mdly/history/";

/**
 * Slot regex — MUST stay byte-identical to `COMMENT_LOG_PATTERN` in
 * `apps/www/worker/durableObject/files.ts` (currently line 208):
 * `/^\.mdly\/comments\/(.+?)(?: (\d+))?\.jsonl$/i`. The server polices who
 * may write which comment file with it; this module reads slot ownership
 * with it. If the server pattern changes, this one changes in lockstep —
 * do not "improve" one side alone.
 */
const COMMENT_LOG_PATTERN = /^\.mdly\/comments\/(.+?)(?: (\d+))?\.jsonl$/i;

/**
 * Narrow allowlist predicate: true only for the sidecar kinds cloud sync
 * will ever carry — comment logs at any depth under `.mdly/comments/` plus
 * the history index shards directly under `.mdly/history/`. Everything else
 * under `.mdly/` (revision blobs, config, locks) stays local forever.
 */
export function isSyncedSidecarPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	if (
		normalized.startsWith(COMMENTS_PREFIX) &&
		normalized.length > COMMENTS_PREFIX.length
	) {
		return normalized.toLowerCase().endsWith(".jsonl");
	}
	if (normalized.startsWith(HISTORY_PREFIX)) {
		const rest = normalized.slice(HISTORY_PREFIX.length);
		// Top level only (`index*.jsonl`): no nested shards, no objects dir.
		if (rest.includes("/")) return false;
		return /^index[^/]*\.jsonl$/i.test(rest);
	}
	return false;
}

/**
 * Slot owning a comment log, mirroring the server invariant exactly:
 * - `undefined` — not a comment log at all (history index, note, …).
 * - `null` — canonical unsuffixed log (`.mdly/comments/<base>.jsonl`),
 *   owned by callers that never registered a slot (desktop/CLI).
 * - `number` — slotted sibling (`<base> <n>.jsonl`), owned by the browser
 *   registered for slot `n`.
 */
export function commentLogSlotOf(path: string): number | null | undefined {
	const normalized = path.replace(/\\/g, "/");
	const match = COMMENT_LOG_PATTERN.exec(normalized);
	if (!match) return undefined;
	return match[2] !== undefined ? Number(match[2]) : null;
}

/**
 * True for the synced sidecars THIS device (desktop/CLI, slotless) may
 * push: the canonical comment log plus the history index shards. Slotted
 * browser siblings are never pushable here — the server would reject them,
 * correctly — and unsynced sidecars are never pushable anywhere.
 */
export function isPushableSidecarPath(path: string): boolean {
	if (!isSyncedSidecarPath(path)) return false;
	const slot = commentLogSlotOf(path);
	if (slot === undefined) return true; // history index: no slot invariant
	return slot === null; // canonical: pushable; slotted sibling: not
}
