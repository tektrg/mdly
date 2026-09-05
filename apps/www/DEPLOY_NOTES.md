# Deploy notes — garden.theindie.app

**Status: NOT yet deployed.** Everything below is a live checklist for the first
deploy. `wrangler.toml` in this folder is complete except for one placeholder
(the KV namespace id), which step 2 fills in.

Mirrors the proven pattern in `apps/notion-web` (live on `mdly.theindie.app`
since 2026-07-07): a Worker that serves the Vite SPA as static assets and runs
first only for `/api/*`.

## Preconditions

- `wrangler` is already authenticated on this machine (`apps/notion-web` ships
  with it). Confirm with `pnpm exec wrangler whoami`.
- The `theindie.app` zone is already in the same Cloudflare account — that is
  what makes `garden.theindie.app` a one-line custom domain rather than a
  DNS setup task.

## First deploy — in this order

The three resources must exist before the first `wrangler deploy`, or the
deploy fails on an unresolvable binding.

### 1. Create the R2 bucket — ✅ DONE 2026-09-02

```sh
cd apps/www
pnpm exec wrangler r2 bucket create mdly-garden-assets
```

Already created in account `9cd49d097f431e967341161edc370cfb`
(luongtattrung@gmail.com), Standard storage class. Holds content-addressed
image bytes at `assets/<sha256>`. The name matches `wrangler.toml`'s
`[[r2_buckets]] bucket_name` — leave both alone.

Ignore the snippet wrangler prints suggesting
`binding = "mdly_garden_assets"`; our binding is `ASSET_BUCKET` and the code
depends on that name.

### 2. Create the KV namespace, then paste the id into `wrangler.toml`

**The obvious name is already taken.** `wrangler kv namespace create SESSIONS`
fails with *"A KV namespace with the title SESSIONS already exists"* — that is
`apps/notion-web`'s namespace (id `d44eb40d9e594aaaa7d328d7fe026133`). Do NOT
reuse it: these two Workers must stay isolated, so one app's session store can
never read or evict the other's. Use a distinct title:

```sh
cd apps/www
pnpm exec wrangler kv namespace create mdly-garden-SESSIONS
```

Copy the printed id over `REPLACE_WITH_REAL_KV_NAMESPACE_ID` in
`wrangler.toml` (the `binding = "SESSIONS"` line stays as it is — the binding
name is what the code uses and is unrelated to the namespace's title). This
namespace holds login sessions **and** the workspace registry.

### 3. Set the password — MUST happen BEFORE the first deploy

```sh
cd apps/www
pnpm exec wrangler secret put APP_PASSWORD
```

The single shared login password. Never committed, never in the JS bundle,
never in `.hubble/config.json`.

**Do not deploy before this step.** The Worker fails closed if the secret is
missing (added 2026-09-02, `worker/auth.ts`'s `passwordConfigured`, covered by
6 tests in `worker/auth.test.ts`), so a passwordless deploy is now merely
useless rather than dangerous. Before that fix it was genuinely dangerous:
`timingSafeEqual` compared the presented token against an absent secret, so a
literally empty credential (`Authorization: Bearer ` with nothing after the
space) matched and `GET /api/workspaces` returned **200** — verified live
against a local Worker with no secret bound. Set the secret first regardless.

### 4. Deploy

```sh
pnpm --filter @hubble.md/www deploy
```

Runs `tsc -b && vite build` then `wrangler deploy`. The
`routes = [{ pattern = "garden.theindie.app", custom_domain = true }]` line
makes Cloudflare create the DNS record itself — a proxied `CNAME`
`garden` → the Worker, orange-cloud. No manual DNS edit.

## After the deploy — the one thing that needs the dashboard

Brute-force protection is deliberately **not** in the Worker code (no per-IP
throttling, no KV backoff). Create it by hand instead:

> **Cloudflare dashboard → `theindie.app` → Security → WAF → Rate limiting rules → Create rule**
>
> | Field | Value |
> |---|---|
> | Rule name | `garden login throttle` |
> | If incoming requests match | `Hostname equals garden.theindie.app` **AND** `URI Path equals /api/login` |
> | Rate | `10` requests per `1 minute` |
> | Counting characteristic | IP address |
> | Then take action | Block |
> | Duration | `10 minutes` |

Ten tries a minute is generous for one human and useless for a password
guesser.

## Verifying it is actually live

The plan's four pass conditions, checked over real HTTPS:

1. Save a note on the Mac → a phone browser shows the new text in under 5s.
2. A wrong password shows nothing, and no `/api/*` route answers without a
   cookie or bearer token.
3. Kill the phone's connection for a minute, restore it → the page resyncs with
   no manual reload.
4. A note matching `.gitignore` never appears in the cloud.

## Before switching ANY folder on — run the dry-run

Nothing leaves the Mac until a specific folder is switched on, and the dry-run
tells you exactly what that switch would upload. Run it from the repo root,
pointing at the real workspace:

```sh
node packages/cli/dist/index.js --cwd "/path/to/your/workspace" cloud dry-run
```

Verified working output (2026-09-01, on a throwaway folder with `secret/` in
its `.gitignore`):

```text
Cloud Sync dry run: /.../dryrun-demo

Would sync (1):
  notes/a.md

No longer synced under the new .gitignore-aware rules (1) — add a .gitignore
entry if this is intentional:
  - secret/b.md
```

Read the "Would sync" list before switching the folder on. If anything on it
should not be readable from a browser, add it to `.gitignore` and re-run. The
walker uses the same ignore rules as the Mac app's sidebar, including nested
`.gitignore` files and negation patterns.

## Redeploy

```sh
pnpm --filter @hubble.md/www deploy
```
