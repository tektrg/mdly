import type { Env as WorkerEnv } from "./env.js";

/**
 * `cloudflare:test`'s `env` export (used throughout worker/*.test.ts) is
 * typed as the ambient `Cloudflare.Env` namespace interface, which
 * `@cloudflare/vitest-pool-workers` expects a project to declare (normally
 * via `wrangler types`, which infers it from wrangler.toml alone — missing
 * runtime-only bindings like the `APP_PASSWORD` secret that isn't in
 * wrangler.toml). Rather than keep a second, generated copy of the Env shape
 * in sync with our hand-written one in env.ts (which apps/notion-web's env.ts
 * also does NOT generate — this mirrors that precedent), this file merges
 * our single hand-written `Env` into that ambient namespace directly.
 */
declare global {
	namespace Cloudflare {
		interface Env extends WorkerEnv {}
	}
}
