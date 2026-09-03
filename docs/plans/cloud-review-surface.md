# Plan: Cloud Review Surface (garden.theindie.app)

**Status:** Phase 1 IMPLEMENTED, not yet deployed — 2026-09-01. All six slices (1.1-1.6) are
built and tested; the Worker has NOT been deployed, so `garden.theindie.app` does not exist yet.
Full run log, per-rule coverage and the remaining hand-off steps live in
`memory/Projects/deliver-phase-1-of-the-cloud-review-surface-for-mdly-slices-1-1-1-6-per/`
(`status.md` for the narrative, `coverage.json` for per-rule state,
`apps/www/DEPLOY_NOTES.md` for the deploy checklist). Phases 2 and 3 remain unstarted.

Decisions the user made during delivery that this document predates: cloud sync defaults OFF
per workspace behind an explicit opt-in, plus a `hubble cloud dry-run` command; switching sync
OFF DELETES that workspace's cloud copy; brute-force protection is a hand-configured Cloudflare
dashboard rate-limit rule, deliberately not code; the session cookie uses a sliding 30-day
expiry; and the opt-in switch lives in the Mac app's settings panel.

**Supersedes:** the *Phase 2* section of `docs/plans/local-doc-comments.md` (which named
Convex + `apps/www` and is now stale on the backend choice).
**Builds on:** `docs/plans/local-doc-history.md` (shipped), `docs/plans/local-doc-comments.md`
Phase 1 (shipped).

## What the user gets

> Open `garden.theindie.app` from any device, enter a password, and see every note in
> your Mac workspace — updating within seconds of a local save. Scrub a note's version
> timeline, read the diff of what your agent just changed, select text and leave a
> comment. The comment lands back in the workspace folder on your Mac.

Single user, three-plus reviewing devices (Mac browser, iPhone web, Android web) plus the
Mac desktop app itself.

## Locked decisions

| Question | Decision |
|---|---|
| Can the web edit `.md`? | **No.** Read + diff + comment only. The Mac is the sole author of notes |
| Backend | **Cloudflare only.** Worker + Durable Object (SQLite storage) + R2. No Convex |
| `packages/sync-backend` and `packages/convex-client` | **Deleted** (see *Deletion is atomic*) |
| Version history transport | Sync the small JSONL logs; keep version **bytes in R2 keyed by sha256**. Never sync `.mdly/history/objects/**` |
| Version retention | **Last 50 versions per note** |
| Auth | Browser = session cookie, same origin. Mac (app + CLI) = bearer token in Keychain |
| Domain | `garden.theindie.app` |
| Which files sync | Same ignore rules as the Mac app's sidebar (`.gitignore` / `.ignore` + hard prunes), plus a separate explicitly-scoped sidecar walker |
| Who runs the sync | **Inside the desktop app** (not the CLI watcher) |
| Web offline | **Not supported.** The review surface is online-only; offline comment authoring stays desktop-only |

---

## Why Cloudflare-only is cheaper than deploying Convex

1. `packages/sync/src/backend.ts` is already a **backend-agnostic 10-method interface**.
   Convex is one adapter (`packages/convex-client`, ~108 lines). Cloudflare is a sibling
   adapter. The sync engine, conflict logic, config format, CLI and desktop wiring are
   untouched.
2. **Convex was never deployed.** No `.env.local` exists anywhere in the repo; the CLI
   falls back to `http://127.0.0.1:3210` (a local `convex dev` sandbox). Zero data to
   migrate.
3. `packages/sync-backend/convex/orphanAssets.ts` (134 lines) is **pure functions with no
   Convex imports** — it ports verbatim. Only `sync.ts` (440 lines) and `crons.ts` (15
   lines) are Convex-shaped.
4. **Auth gets structurally safer.** With Convex the browser talks *directly* to Convex,
   bypassing the Worker — which is the only reason a shared secret would have to be
   injected into the page after login. Cloudflare-only is same-origin behind a cookie:
   nothing to inject, no third-party address in the bundle.
5. One vendor, one `wrangler deploy`, one dashboard. `mdly.theindie.app` already proves the
   Worker + KV + custom-domain path in this repo (`apps/notion-web/DEPLOY_NOTES.md`).

### What is genuinely given up

| Lost | Consequence |
|---|---|
| Reactive queries | Change notification is hand-rolled: a write bumps a counter, the DO broadcasts, the client refetches. Small, but **a missed broadcast is a silently stale page** — a heartbeat + resync-on-reconnect is mandatory, not optional |
| Generated end-to-end types | Replaced by a hand-written client validated with zod (already a `packages/sync` dependency) |
| `convex dev` ergonomics | `wrangler dev` emulates DO + R2 locally, but DO migrations/versioning are manual |
| Elastic storage | SQLite-backed DO caps at 10GB **per workspace** — a wall, not a shared pool. Irrelevant at personal-notes volume |
| ~2 days | The adapter is work that deploying Convex as-is would have skipped |

---

## Architecture

### Components

| Concern | Implementation |
|---|---|
| Workspace state | **One Durable Object per workspace**, SQLite storage. All writes for a workspace serialize through it — the concurrent-write race class does not exist |
| Note bytes (current) | Row in the DO's SQLite. Small, hot, read on every page load |
| Version bytes (history) | **R2, key = `versions/<sha256>`.** Content-addressed, so dedupe is free and it *is* the remote equivalent of `.mdly/history/objects/` |
| Image assets | **R2, key = `assets/<sha256>`.** Served via `GET /api/asset/<hash>` behind the cookie |
| Near-realtime | DO **hibernating WebSocket**. Any mutation increments a workspace `version` counter and broadcasts it; clients refetch. Slots into the existing `Subscriber` interface (`onFilesChanged` / `onAssetsChanged`) with no interface change |
| Nightly asset GC | Worker **Cron Trigger**, calling the ported pure functions from `orphanAssets.ts`, keeping the existing mark-then-delete-after-7-days grace period |
| Auth | Worker middleware. Cookie for browsers, bearer token for the Mac |

### Why the hash alignment matters

`packages/doc-history/src/hash.ts` is a copy of `packages/sync`'s `contentHash` — both are
**sha256 hex of raw UTF-8 bytes**. So `revision.hash` in a synced revision log is a valid
R2 key without any translation layer. This is what makes "sync the logs, not the blobs"
work: the log says which versions exist, R2 holds the bytes for every version that was
live at a sync moment.

**Accepted gap:** a revision cut and superseded *between* two syncs appears in the web
timeline but its diff reports *bytes not available*. With in-app sync (250ms debounce) that
window is seconds wide. It must be a visible state, never a silent empty diff.

### Data model (DO SQLite)

| Table | Columns |
|---|---|
| `files` | `path` PK, `contentHash`, `content`, `updatedAt`, `deviceId`, `deleted` |
| `assets` | `path` PK, `hash`, `updatedAt`, `orphanedAt`, `deviceId`, `deleted` |
| `versions` | `path`, `hash`, `at`, `deviceId` — index `(path, at DESC)`. Prune beyond 50 per path |
| `devices` | `deviceId` PK, `slot` UNIQUE, `label`, `firstSeenAt`, `lastSeenAt` |
| `meta` | `version` counter (broadcast on every mutation) |

R2 objects are deleted only when **no `versions` or `assets` row anywhere references the
hash** — content addressing means a hash can be shared across paths. GC runs on the cron,
never inline on a push.

---

## Identity, devices, and comment forking

Three-plus reviewing devices is what forces this section. Comments are append-only JSONL
files inside the workspace; two writers appending to the *same path* would be resolved by
last-writer-wins and **silently lose lines**. Distinct paths never conflict.

### Slot assignment

- `packages/doc-history/src/jsonlLog.ts` globs siblings with exactly
  `^<base>( \d+)?\.jsonl$`. A name like `<docId>.web.jsonl` is **silently ignored** and its
  comments would vanish. The suffix must be ` <integer>`.
- The **desktop app owns the canonical log** — `.mdly/comments/<docId>.jsonl`, no suffix.
- Each browser registers once (`POST /api/device/register`) with the uuid it already
  generates (`apps/www/src/connection/deviceId.ts`); the DO assigns the next free slot
  starting at **2** and returns it. Persisted in `localStorage` beside the uuid.
- A browser appends only to `.mdly/comments/<docId> <slot>.jsonl`.

### Server-enforced invariant

The Worker **rejects** any write to `.mdly/comments/*` whose slot suffix does not match the
caller's registered slot, and rejects any browser write to a canonical (unsuffixed) comment
log. Cheap check, and it makes cross-device comment loss structurally impossible rather
than merely unlikely.

### Reading across slots

Both surfaces must glob every sibling slot, not just their own:
- Desktop: already does (`findJsonlSiblingPaths` over the real filesystem).
- Web: the `DocHistoryFileSystem` adapter over remote rows **must implement `listDir`**
  correctly, or a device sees only its own comments. This is the single easiest thing to
  get wrong in Phase 3.

### Relationship to the "no field may assume a server" constraint

`docs/plans/local-doc-comments.md` constraint 3 holds: no comment **event field** is
server-assigned. The slot affects only the *filename*. Server dependence is confined to the
browser, which is online by definition. The desktop path — canonical log, locally minted
ids, no network — is unchanged, so a workspace on iCloud still carries comments between
Macs with no backend at all.

**Consequence to accept:** a browser that clears its storage gets a new uuid and a new
slot, leaving an orphaned fork file. Harmless (append-only, merged by event id) but slots
creep. A device list in settings is the eventual answer, not a v1 blocker.

---

## Ignore rules — "same as the Mac app"

The Mac app's sidebar uses `discoverWorkspaceFiles` from
`packages/workspace-kit/src/file-discovery.ts`: nested `.gitignore` / `.ignore` with Git
negation semantics, plus hard prunes (`.git`, `node_modules`, `dist`, `.dev-electron`) and
`isVisibleFolderName` hiding `.hubble`, `.mdly`, `*.assets`.

`packages/sync/src/fs-node.ts` currently does something completely different: it skips
**every** dot-prefixed entry and honours no ignore file at all.

### The reuse problem

`file-discovery.ts` is pure Node — only `node:fs/promises`, `node:path`, and `ignore`; no
React — and is already a separate entry point (`@mdly/workspace-kit/file-discovery`). But
having `packages/sync` (and therefore the CLI) depend on the whole React kit is wrong.

**Decision: extract it into a new `packages/workspace-scan`**, with the kit re-exporting from
it for backwards compatibility. One file moved, one re-export. Copying it into
`packages/sync` is out — it duplicates ~350 lines of subtle Git-negation and symlink logic.

### Three walkers, deliberately different

| Walker | Scope | Ignore behaviour |
|---|---|---|
| Notes | `.md` / `.markdown` / `.mdown` | Full Mac-app rules; prunes `.mdly` and `.hubble` |
| Assets | images ≤10MB | Full Mac-app rules, but **must traverse `*.assets`** (that is where images live — the sidebar hides those folders, sync cannot) |
| Sidecars | `.mdly/**/*.jsonl` **only** | **Bypasses ignore rules by design** — app-private data the user never means to gitignore. Hard-excludes `.mdly/history/objects/**` |

**Behaviour change to expect:** today a file in any dot-folder never syncs. After this, a
non-ignored `.something/note.md` will sync. Anything that must stay on the Mac needs a
`.gitignore` / `.ignore` entry.

---

## Sidecar sync: never overwrite

On divergence, a sidecar JSONL is **never overwritten and never conflict-copied** — the
puller writes a numbered sibling (`<base> <n>.jsonl`). Every reader already globs and merges
siblings deduped by event id, so this needs **zero new merge logic**. The existing
conflict-copy path would silently drop lines and must not run for `.mdly/**`.

---

## Phases

### Phase 1 — prove the core loop

| # | Ships | Size |
|---|---|---|
| 1.1 | **Cloudflare backend.** Worker + DO (SQLite) + R2. The 10 `SyncBackend` methods, the WebSocket broadcast, device registration, the slot invariant, the ported `orphanAssets` pure functions, the cron | M |
| 1.2 | **`packages/cloudflare-client`** implementing `SyncBackend` + `Subscriber`, validated with zod. **Atomically deletes `packages/sync-backend` and `packages/convex-client`** and repoints `packages/cli` + `apps/www` | S |
| 1.3 | **`packages/workspace-scan`** extraction; `packages/sync` switched onto it; the three walkers above | S |
| 1.4 | **Desktop sync** — `apps/desktop/electron/cloudSyncWiring.ts`, shaped like the existing `docHistoryWiring.ts`: workspace watcher (250ms debounce), remote subscription, sync-status indicator, bearer token in Keychain | M |
| 1.5 | **Web read-only** — `apps/www`: editor non-editable, save/conflict paths removed, `ConnectScreen` / `OpenWorkspaceScreen` / `CreateWorkspaceForm` dropped (the Worker supplies the workspace) | S |
| 1.6 | **Deploy** — one Worker on `garden.theindie.app`: password → cookie in KV, static assets, `/api/*`, SPA deep-link fallback | S |

**Pass conditions**
1. Save a note on the Mac; a phone browser shows the new text in under 5s.
2. Wrong password shows nothing; no API route answers without a cookie or bearer token.
3. Kill the phone's connection for a minute, restore it — the page resyncs without a manual
   reload (proves the heartbeat, the thing Convex used to do for free).
4. A note matching `.gitignore` never appears in the cloud.

### Phase 2 — diff

| # | Ships | Size |
|---|---|---|
| 2.1 | Sidecar sync (walker + numbered-sibling pull path + `objects/` exclusion) | S |
| 2.2 | R2 version store keyed by hash, `versions` index, 50-per-note prune, refcounted GC on the cron | S |
| 2.3 | `DocHistoryFileSystem` adapter over remote rows (**including `listDir`**); web timeline + diff reusing the kit's `RevisionList` / `RevisionDiffView` unchanged | M |

**Pass conditions:** let Claude Code edit a note; the web shows the revision and a correct
region diff. A revision whose bytes never synced renders an explicit
*version bytes unavailable* state, not an empty diff.

### Phase 3 — comments from the web

| # | Ships | Size |
|---|---|---|
| 3.1 | Web comment UI — the kit's `CommentExtension` / `CommentGutter` / `CommentComposer` inside the read-only editor | M |
| 3.2 | Slot-suffixed fork writes; server-side slot enforcement; cross-slot read on both surfaces | S |

**Pass conditions:** comment from iPhone and from Android on the same note; both appear on
the Mac **and** on each other, and the Mac's canonical log is byte-unchanged. Anchoring uses
revision replay when R2 has the bytes and falls back to quote-plus-context otherwise —
never a silent mis-anchor.

---

## Risks

| Risk | Standing |
|---|---|
| Hand-rolled change notification | The one capability genuinely lost with Convex. A dropped broadcast is invisible. Heartbeat + resync-on-reconnect is a Phase 1 pass condition, not a nicety |
| Cross-device comment loss | Structurally prevented by distinct slot paths **and** the server-side slot check. Both are required; either alone is a hope |
| `listDir` in the web fs adapter | Get it wrong and each device sees only its own comments — a plausible-looking, wrong UI. Needs an explicit two-device test |
| Ignore-rule behaviour change | Files in dot-folders start syncing. Worth one pass over the real workspace before first deploy |
| DO 10GB per workspace | Not a concern at personal volume, but it is a hard per-workspace wall |
| Everything leaves the Mac | Any folder that must not reach the cloud needs an ignore entry. No allow-list exists |

## Deletion is atomic

`packages/sync-backend` → `packages/convex-client` → `{packages/cli, apps/www}`. Deleting
the backend alone breaks the client, which breaks the CLI and the web app. Slice 1.2 removes
both Convex packages and repoints both consumers in one commit; anything else leaves the
monorepo unbuildable.

Consequence accepted: this diverges from upstream `bholmesdev/hubble.md`, making future
merges of its sync code manual. The upstream Convex functions remain in git history.

## Open items

1. **Retention policy for comment logs** — still unspecified (inherited from
   `local-doc-comments.md`). Fine for years; decide before it is a support question.
2. **Device labels.** Slots are integers; a device list with human names is deferred.
3. **`.gitignore` pass over the live workspace** before the first deploy — required, since
   the ignore semantics change.
4. An ADR is probably owed for "Cloudflare Durable Object per workspace" and for
   "web is read-only for notes".
