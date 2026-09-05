import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Miniflare/vitest config for the garden.theindie.app Worker (Stage 1 test
 * gate: "proven against Miniflare/vitest before any client exists"). Reuses
 * the real wrangler.toml so bindings here are never a second,
 * independently-hand-maintained copy of the deploy config.
 *
 * `APP_PASSWORD` and `WORKSPACE_STORAGE_CAP_BYTES` aren't in wrangler.toml
 * (the former is a real secret set via `wrangler secret put`; the latter is
 * an optional override) — both are supplied here as plain test bindings so
 * the suite has a deterministic password to assert against and a small
 * enough storage cap to exercise R7 without writing gigabytes of fixture
 * data.
 */
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.toml" },
			miniflare: {
				bindings: {
					APP_PASSWORD: "correct-horse-battery-staple",
					WORKSPACE_STORAGE_CAP_BYTES: "2000000",
				},
			},
		}),
	],
});
