import type { RemoteFile } from "@hubble.md/sync";

/**
 * Web read-path sidecar partition (Round 6). The `getFiles` result carries
 * comment logs + history index shards as ordinary rows; the store splits
 * them here so notes (`files`) and sidecars (`sidecars`) never mix —
 * which also keeps the sidebar and wiki-link targets clean with no change
 * to either. One shared helper feeds all three ingestion paths (initial
 * snapshot, refresh, broadcast) so devices can never disagree.
 */

export const SIDECAR_PREFIX = ".mdly/";

/** A synced sidecar row WITH content (unlike FileEntry, which drops it). */
export type SidecarEntry = {
	path: string;
	content: string;
	contentHash: string;
	updatedAt: number;
};

/** Broad fence: every `.mdly/` row is a sidecar, never a note. */
export function isSidecarRow(path: string): boolean {
	return path === ".mdly" || path.startsWith(SIDECAR_PREFIX);
}

/**
 * Builds the path-keyed sidecar map. Tombstoned rows are excluded — a
 * deleted remote row must not linger as readable content.
 */
export function toSidecarMap(
	remote: Pick<
		RemoteFile,
		"path" | "content" | "contentHash" | "updatedAt" | "deleted"
	>[],
): Record<string, SidecarEntry> {
	const map: Record<string, SidecarEntry> = {};
	for (const f of remote) {
		if (f.deleted) continue;
		if (!isSidecarRow(f.path)) continue;
		map[f.path] = {
			path: f.path,
			content: f.content,
			contentHash: f.contentHash,
			updatedAt: f.updatedAt,
		};
	}
	return map;
}

/**
 * True when the map's readable content actually moved — a key added or
 * removed, or any surviving key's hash changed. Hash-only comparison, so a
 * redundant broadcast (same content, new updatedAt) never bumps
 * `commentsVersion` and never re-renders comment surfaces.
 */
export function sidecarsChanged(
	prev: Record<string, SidecarEntry>,
	next: Record<string, SidecarEntry>,
): boolean {
	const prevKeys = Object.keys(prev);
	if (prevKeys.length !== Object.keys(next).length) return true;
	for (const key of prevKeys) {
		if (next[key]?.contentHash !== prev[key]?.contentHash) return true;
	}
	return false;
}
