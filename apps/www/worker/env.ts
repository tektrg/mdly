import type { WorkspaceDurableObject } from "./durableObject/workspaceDurableObject.js";

/**
 * Cloudflare bindings for the garden.theindie.app Worker.
 *
 * Mirrors the shape of apps/notion-web/worker/env.ts: one KV namespace for
 * session state, static SPA assets, plus (new here) one Durable Object
 * namespace (SQLite-backed, one instance per workspace via idFromName) and
 * one R2 bucket for content-addressed asset/version bytes.
 */
export type Env = {
	/** Static SPA assets (Vite `dist`). */
	ASSETS: Fetcher;
	/** session-id -> stored session (JSON). Also used as the workspace registry. */
	SESSIONS: KVNamespace;
	/** One Durable Object instance per workspace name (idFromName(name)). */
	WORKSPACE_DO: DurableObjectNamespace<WorkspaceDurableObject>;
	/** Content-addressed asset bytes: key = `assets/<sha256>`. */
	ASSET_BUCKET: R2Bucket;

	/** The single shared login password (set via `wrangler secret put APP_PASSWORD`). */
	APP_PASSWORD: string;

	/**
	 * Per-workspace storage cap in bytes, enforced at the application level as
	 * an early, specific error ahead of the DO SQLite storage's own hard
	 * (10GB) ceiling. Overridable so tests can exercise the cap cheaply
	 * without writing gigabytes of fixture data.
	 */
	WORKSPACE_STORAGE_CAP_BYTES?: string;
};

export const DEFAULT_WORKSPACE_STORAGE_CAP_BYTES = 10 * 1024 * 1024 * 1024; // 10GB

export function workspaceStorageCapBytes(env: Env): number {
	const raw = env.WORKSPACE_STORAGE_CAP_BYTES;
	if (!raw) return DEFAULT_WORKSPACE_STORAGE_CAP_BYTES;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0
		? parsed
		: DEFAULT_WORKSPACE_STORAGE_CAP_BYTES;
}

/** Session stored in KV, keyed by the httpOnly cookie's session id. */
export type StoredSession = {
	createdAt: number;
};
