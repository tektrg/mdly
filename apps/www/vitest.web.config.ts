import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import icons from "unplugin-icons/vite";
import { defineConfig } from "vitest/config";

/**
 * Stage 5 (R31, R34-R37, R39): a SEPARATE config from the frozen
 * `vitest.config.ts` (Stage 1's Miniflare/Workers-pool config for
 * `apps/www/worker/**`, out of scope for this delivery — see the charter).
 * `pnpm exec vitest run worker` keeps using that one untouched; frontend
 * component/store tests under `src/**` run through this one instead
 * (`pnpm test:web` / `vitest run --config vitest.web.config.ts`), using a
 * plain Vite+React transform with no cloudflare:test pool involved.
 *
 * No global `environment` is set here, matching this monorepo's existing
 * convention (see `packages/workspace-kit`, which has no `test.environment`
 * either): individual test files opt into a DOM environment per-file with
 * `// @vitest-environment happy-dom`, exactly like
 * `packages/workspace-kit/src/ui/FormattingStatusBar.test.tsx` and
 * `packages/workspace-kit/src/comments/__tests__/ThreadPanel.test.tsx` do —
 * so this suite follows the same pattern (`react-dom/client`'s `createRoot`
 * + `act`) rather than introducing React Testing Library as a new,
 * unprecedented dependency.
 *
 * File naming — `*.browsertest.tsx`, not `*.test.tsx` — is load-bearing, not
 * stylistic: the frozen `vitest.config.ts` next to this file (Stage 1's
 * Miniflare/Workers-pool config for `apps/www/worker/**`) sets no
 * `test.include`, so it falls back to vitest's own default glob
 * (`**\/*.{test,spec}.tsx` etc.), which would otherwise also sweep up these
 * frontend tests and try to run them inside the Workers-pool sandbox — where
 * happy-dom's `SyncFetch` fails at import time (`No such module
 * "node:child_process"`), surfacing as noisy unhandled errors on every
 * `pnpm test:worker` run even though the frozen suite's own tests stay
 * green. Suffixing these files `.browsertest.tsx` keeps them outside that
 * default glob entirely, without editing the frozen config.
 */
export default defineConfig({
	plugins: [
		react(),
		icons({
			compiler: "jsx",
			jsx: "react",
		}),
		tailwindcss(),
	],
	resolve: {
		alias: {
			// Mirrors apps/desktop/vite.config.ts's rationale verbatim: run
			// against @mdly/workspace-kit's live TS source rather than its built
			// dist, so this suite never depends on a fresh `pnpm build` having
			// been run for that package first.
			"@mdly/workspace-kit": fileURLToPath(
				new URL("../../packages/workspace-kit/src/index.ts", import.meta.url),
			),
		},
	},
	test: {
		include: ["src/**/*.browsertest.{ts,tsx}"],
	},
});
