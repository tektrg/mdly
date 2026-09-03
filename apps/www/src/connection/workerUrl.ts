/**
 * D6: apps/www is always served same-origin with its own Cloudflare Worker
 * (mirrors apps/notion-web) — there's no arbitrary deployment URL for a user
 * to type in or persist, unlike the old Convex-era ConnectScreen. In local
 * dev, vite.config.ts proxies `/api` to a locally-running `wrangler dev`
 * Worker, so `window.location.origin` (Vite's own origin) still resolves
 * every request correctly.
 */
export const WORKER_BASE_URL = window.location.origin;
