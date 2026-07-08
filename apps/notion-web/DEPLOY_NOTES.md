# Deploy notes — mdly.theindie.app

**Status (2026-07-07): v1 deployed and live.** Homepage, Worker API
(`/api/session`), SPA deep-link fallback, and the auth guard all verified over
HTTPS.

## What's live

- Cloudflare Worker `mdly-notion-web` on the custom domain `mdly.theindie.app`.
- Serves the Vite SPA as static assets; runs first for `/api/*` and `/auth/*`.
- KV namespace `SESSIONS` (id `d44eb40d9e594aaaa7d328d7fe026133`) for
  session-id → Notion OAuth token.
- Notion API version pinned to `2026-03-11`.

## Remaining to go fully functional (needs owner input)

Connecting a workspace requires a Notion **public** OAuth integration, which
can't be created programmatically:

1. Create it at <https://www.notion.so/my-integrations> (public integration,
   OAuth). Redirect URI: `https://mdly.theindie.app/auth/notion/callback`.
   Enable read + update content capabilities. Submit for Notion review if you
   want anyone beyond yourself to connect.
2. Set the secrets on the Worker:
   ```sh
   cd apps/notion-web
   pnpm exec wrangler secret put NOTION_CLIENT_ID
   pnpm exec wrangler secret put NOTION_CLIENT_SECRET
   ```
Until then, the app loads and shows "Notion credentials are not configured."

## Redeploy

```sh
pnpm --filter @hubble.md/notion-web deploy
```
