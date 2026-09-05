import { historyRootFor, resolvePathIndex } from "@mdly/doc-history";
import { createRemoteFileSystem } from "./remoteFileSystem";
import type { SidecarEntry } from "../store/sidecars";

/**
 * Web read-path docId resolution (Round 6): replays the synced
 * `.mdly/history/index.jsonl` AND its numbered siblings through
 * `resolvePathIndex` over the remote filesystem, so a note renamed on the
 * Mac still resolves to its current path here.
 *
 * Read-only by construction: when the open path has no docId this returns
 * `undefined` and never mints one — the web never writes the history
 * index. Results memoize on `commentsVersion`, which only moves when
 * sidecar content actually changes.
 */
let cached: {
	version: number;
	byPath: Map<string, string>;
} | null = null;

export async function resolveDocIdForPath(
	openPath: string,
	sidecars: Record<string, SidecarEntry>,
	commentsVersion: number,
): Promise<string | undefined> {
	if (!cached || cached.version !== commentsVersion) {
		const byPath = await resolvePathIndex(
			createRemoteFileSystem(sidecars),
			historyRootFor(""),
		);
		cached = { version: commentsVersion, byPath };
	}
	return cached.byPath.get(openPath);
}

/** Test-only reset for the module-level memo. */
export function resetDocIdCache(): void {
	cached = null;
}
