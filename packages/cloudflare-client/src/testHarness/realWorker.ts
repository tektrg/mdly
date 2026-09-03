import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

/**
 * Boots the REAL Stage 1 Worker (apps/www/worker/index.ts — untouched by
 * this delivery) inside a real Miniflare instance, so
 * packages/cloudflare-client's tests exercise the actual Worker + Durable
 * Object + R2 + KV stack, not a hand-rolled HTTP mock (per the test plan's
 * "no mocks standing in for the actual Worker" rule).
 *
 * apps/www/worker itself is bundled fresh with esbuild (mirroring what
 * `wrangler dev`/`wrangler deploy` does before handing a script to
 * workerd) — Miniflare's programmatic API takes a single bundled ES module,
 * not a multi-file TS source tree.
 */

const WORKER_ENTRY = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../apps/www/worker/index.ts",
);

export const TEST_PASSWORD = "correct-horse-battery-staple";
const DEFAULT_STORAGE_CAP_BYTES = 50_000_000;

export type RealWorkerHandle = {
	baseUrl: string;
	dispose(): Promise<void>;
};

let bundledWorkerCode: string | null = null;

async function bundleWorker(): Promise<string> {
	if (bundledWorkerCode) return bundledWorkerCode;
	const result = await build({
		entryPoints: [WORKER_ENTRY],
		bundle: true,
		format: "esm",
		target: "es2022",
		platform: "neutral",
		write: false,
		external: ["cloudflare:workers", "cloudflare:*"],
	});
	const output = result.outputFiles[0];
	if (!output)
		throw new Error("esbuild produced no output for the Worker bundle");
	bundledWorkerCode = output.text;
	return bundledWorkerCode;
}

/** Starts a fresh, isolated real Worker instance for one test file. Storage is in-memory and lives only as long as the returned handle. */
export async function startRealWorker(opts?: {
	storageCapBytes?: number;
}): Promise<RealWorkerHandle> {
	const script = await bundleWorker();
	const mf = new Miniflare({
		modules: true,
		script,
		compatibilityDate: "2026-03-01",
		compatibilityFlags: ["nodejs_compat"],
		bindings: {
			APP_PASSWORD: TEST_PASSWORD,
			WORKSPACE_STORAGE_CAP_BYTES: String(
				opts?.storageCapBytes ?? DEFAULT_STORAGE_CAP_BYTES,
			),
		},
		kvNamespaces: ["SESSIONS"],
		r2Buckets: ["ASSET_BUCKET"],
		durableObjects: {
			WORKSPACE_DO: { className: "WorkspaceDurableObject", useSQLite: true },
		},
	});
	const url = await mf.ready;
	return {
		baseUrl: url.origin,
		dispose: () => mf.dispose(),
	};
}
