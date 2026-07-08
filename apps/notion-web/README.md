# mdly — Notion web editor

A lightweight browser app to browse your Notion pages, edit them as clean
markdown in the Hubble editor, and push changes back. Notion is the source of
truth; drafts are kept locally in the browser (IndexedDB).

Reuses `@hubble.md/editor` and `@hubble.md/ui` unchanged. The Notion sync logic
(link frontmatter, content-hash dirty detection, targeted writeback diff,
volatile signed-URL handling) is ported from the desktop app.

## Architecture

- **SPA** (`src/`): Vite + React. Mounts the shared editor, stores drafts in
  IndexedDB, talks to the Worker over `/api` + `/auth`.
- **Worker** (`worker/`): a single Cloudflare Worker that serves the built SPA
  as static assets and proxies the Notion REST API (API version `2026-03-11`).
  It holds the OAuth token server-side (KV, keyed by an httpOnly session
  cookie); the browser never sees it.

## Setup

1. Create a **public** Notion integration at
   <https://www.notion.so/my-integrations> with OAuth. Set the redirect URI to
   `https://mdly.theindie.app/auth/notion/callback` (and a localhost one for
   dev). Enable read + update content capabilities.
2. Create the KV namespace and put its id in `wrangler.toml`:
   ```sh
   pnpm exec wrangler kv namespace create SESSIONS
   ```
3. Set secrets:
   ```sh
   pnpm exec wrangler secret put NOTION_CLIENT_ID
   pnpm exec wrangler secret put NOTION_CLIENT_SECRET
   ```

## Develop

```sh
pnpm --filter @hubble.md/notion-web worker:dev   # Worker on :8787
pnpm --filter @hubble.md/notion-web dev           # SPA on :5174 (proxies /api,/auth)
```

Copy `.dev.vars.example` to `.dev.vars` for local secrets.

## Deploy

```sh
pnpm --filter @hubble.md/notion-web deploy
```

Builds the SPA and deploys the Worker to `mdly.theindie.app`.
