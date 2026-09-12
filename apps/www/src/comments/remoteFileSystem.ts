import type { DocHistoryFileSystem } from "@mdly/doc-history";
import type { SidecarEntry } from "../store/sidecars";

/**
 * Web read-path `DocHistoryFileSystem` (Round 6): implements doc-history's
 * filesystem interface over the partitioned `sidecars` map (remote path →
 * content) with workspaceRoot = "". This is the hinge — `joinPath` filters
 * empty segments, so `commentLogPath("", docId)` produces exactly
 * `.mdly/comments/<docId>.jsonl`, byte-identical to the remote path key,
 * and `historyRootFor("")` is exactly `.mdly/history`.
 *
 * Reads only: the web never overwrites a log (`writeFile` throws) and
 * appending is not this round (`appendText` throws). `mkdirRecursive` is a
 * no-op and `exists` is a key check.
 */
export function createRemoteFileSystem(
	sidecars: Record<string, SidecarEntry>,
): DocHistoryFileSystem {
	const encoder = new TextEncoder();
	return {
		async readFile(path: string): Promise<Uint8Array | null> {
			const entry = sidecars[path];
			return entry ? encoder.encode(entry.content) : null;
		},
		async writeFile(): Promise<void> {
			throw new Error("remote sidecars are read-only on the web");
		},
		async appendText(): Promise<void> {
			throw new Error("web comment writes are not this round");
		},
		async exists(path: string): Promise<boolean> {
			return path in sidecars;
		},
		async mkdirRecursive(): Promise<void> {
			// Nothing to create — the map is the whole filesystem.
		},
		/**
		 * The spec's named trap: for every key, if it starts with
		 * `path + "/"` and the remainder has no further "/", return the
		 * remainder — so ALL slots (canonical, ` 2`, ` 3`, …) surface and
		 * nested paths never flatten into the parent. A missing directory
		 * returns [] and this NEVER throws (`findJsonlSiblingPaths` calls
		 * it unguarded).
		 */
		async listDir(dirPath: string): Promise<string[]> {
			const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
			const names = new Set<string>();
			for (const key of Object.keys(sidecars)) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				if (rest === "" || rest.includes("/")) continue;
				names.add(rest);
			}
			return [...names];
		},
	};
}
