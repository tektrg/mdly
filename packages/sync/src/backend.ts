import type { AuthorizedUrl, RemoteAsset, RemoteFile } from "./types.js";

/** Backend-agnostic interface for sync operations. */
export interface SyncBackend {
	getWorkspace(name: string): Promise<string | null>;
	createWorkspace(name: string): Promise<string>;

	getFiles(
		workspaceId: string,
		opts?: { since?: number; includeDeleted?: boolean },
	): Promise<RemoteFile[]>;
	pushFile(args: {
		workspaceId: string;
		path: string;
		contentHash: string;
		content: string;
		deviceId: string;
	}): Promise<void>;
	/**
	 * Batched push (DO row-read frequency fix): one version bump + one
	 * broadcast per batch instead of one per file. OPTIONAL so older
	 * backends (and unit-test fakes) keep compiling — `execute()` falls
	 * back to the per-file loop when absent. Returns the new workspace
	 * version. Never called with an empty `files` array (the server 400s
	 * it); chunking against the server caps (100 files / 8MiB total /
	 * 2MiB per entry) is the caller's job.
	 */
	pushFilesBatch?(args: {
		workspaceId: string;
		files: {
			path: string;
			contentHash: string;
			content: string;
			deviceId: string;
		}[];
	}): Promise<number>;
	/**
	 * Cheap "did anything change?" check (1-row `meta` read server-side).
	 * OPTIONAL for the same back-compat reason — callers skip the
	 * pre-check and list unconditionally when absent.
	 */
	getVersion?(workspaceId: string): Promise<number>;
	softDeleteFile(args: {
		workspaceId: string;
		path: string;
		deviceId: string;
	}): Promise<void>;

	getAssets(workspaceId: string, since?: number): Promise<RemoteAsset[]>;
	pushAsset(args: {
		workspaceId: string;
		path: string;
		storageId: string;
		contentHash: string;
		deviceId: string;
	}): Promise<void>;
	softDeleteAsset(args: {
		workspaceId: string;
		path: string;
		deviceId: string;
	}): Promise<void>;

	generateAssetUploadUrl(): Promise<AuthorizedUrl>;
	getAssetDownloadUrl(storageId: string): Promise<AuthorizedUrl | null>;
}
