# 202609040059 Cloud sync known open defects and deployed state

Snapshot as of 2026-09-04, after seven fix rounds. Read this before touching
`apps/www/worker`, `packages/sync`, or re-enabling the asset GC.

## What is deployed

`garden.theindie.app`, Worker version `7f148302`, from commit `c58a9c8` (2026-09-03).

Fixed and live:
- **Quadratic DO row reads.** The storage cap no longer re-scans every row on each push; a
  maintained `meta.bytes` counter is adjusted by delta. ~1.6M rows for an initial 1,778-file
  sync → ~6 rows per push. This is the fix for *"Exceeded allowed rows read in Durable Objects
  free tier"*.
- Path traversal (`../`) rejected on files and assets; paths stored byte-for-byte or rejected.
- Internal error text (notably the 32MiB RPC limit string) no longer reaches clients.
- Desktop: `.git/info/exclude` + global git excludes honoured, nested repos pruned — the
  AptusFit freeze is gone (204ms, 647 files).

## THE ASSET GC IS DISARMED — do not re-enable without reading this

`[triggers] crons` is commented out in `apps/www/wrangler.toml`. It arms a **data-loss** path:
the GC deletes R2 objects, and the tombstone propagates to the desktop, which deletes the
user's **local original**.

The same bug — GC deleting an image a live note references — has been fixed four times along
four different axes. See [[202609032210-Shared-path-helper-change-silently-rewired-asset-GC-into-deleting-live-images]]
for the full pattern and the design rule. Axes so far: structural path spelling → `.assets`
folder-name gate → reference syntax (`<img>`, reference-style links) → **per-note relative
resolution** (round 7, in flight).

Re-enable only after a review confirms the reachability check survives, end-to-end through the
real cron: a nested note referencing `note.assets/x.png`, case differences, NFC/NFD filenames,
partially percent-encoded paths, and legacy non-canonical rows — while still collecting a
genuinely unreferenced asset.

## Open defects (none currently reachable by this user's workspace)

| # | Defect | Triggers when | Severity |
|---|---|---|---|
| 1 | Asset GC deletes referenced images (4th axis: relative refs from nested notes) | GC re-armed | **Data loss** — gated by the disarm |
| 2 | Push of a note >~2MB → opaque 500; client push loop aborts the run | a single note >2MB | Sync jams until the note is removed |
| 3 | `GET /api/files` exceeds the 32MiB RPC ceiling → 500 + uncaught rejection | ~32MB total workspace markdown | Permanent sync jam, re-pushes everything each run |
| 4 | Listing page budget counts SQLite characters, not UTF-8 bytes | emoji-heavy notes | Makes #3 reachable at ~1/4 the expected size |
| 5 | `label` on `/api/device/register` uncapped → 500 `UNKNOWN` | >2MB label | Client retries a terminal refusal forever |
| 6 | `failedFiles` has no consumer outside `packages/sync` | any permanently-rejected file | File silently stops syncing, invisible in the UI |
| 7 | `listAssetsForGc()` unpaginated | very large asset counts | Same shape as #3 |

Fixes for 2 and 4 exist **uncommitted** in the working tree (rounds 5–7); only round 4's work
is deployed. #6 needs an `apps/desktop` change and is not covered by any round so far.

Current workspace exposure: AptusFit's largest note is 0.3MB and its total markdown is far
under 32MB, so none of #2–#5 bites today.

## Why this took seven rounds — read before briefing round N+1

Two failure modes recurred, each caught only by adversarial review, never by the round's own
green test suite:

1. **Changing a shared symbol without enumerating its consumers.** Broke the asset GC (twice)
   and the desktop's "sync done" state (once).
2. **Dropping a correct behaviour while replacing a mechanism.** Round 6 swapped AST parsing
   for a containment scan and silently lost per-note relative resolution — the product's own
   `<note>.assets/` convention — because no test used a note in a subfolder.

Both are now explicit done-criteria in every brief: *grep every symbol and shared type field
you touch for consumers, including in packages you may not edit*, and *state which behaviours
of the code you replaced are preserved*.

A third, weaker signal: every round's own tests passed while its bug was live. Tests that
hand-build rows instead of driving the real route or the real cron entrypoint have twice
passed while the exact bug they targeted was reproducible over HTTP.

## Artefacts

Briefs `.brief-do-fix-round-{2..7}.md` at the `hubble-source` repo root (untracked). Each
records the reproduction, the rule, and what the prior round got right.

## Update 2026-09-04 — round 7 reviewed, NOT shipped

Round 7 fixed defects 2/4 and the 4th GC axis, but **introduced a worse P0** and **missed a
fifth GC axis**. Both caught by adversarial review, not by its own green suite. Nothing new
deployed; production still runs round 4 (`7f148302` / `c58a9c8`).

| # | New defect | Evidence |
|---|---|---|
| 8 | `GET /api/files` and `/api/assets` **500 above 100 rows per page** | `SELECT * FROM files WHERE rowid IN (?,?,…)` — one bound parameter per row; DO SQLite caps them at 100. Reproduced over real HTTP: 100 files → 200, 101 files → 500 `too many SQL variables`. `runOrphanAssetCleanup` throws the same at 300 notes. |
| 9 | GC deletes a referenced image, **5th axis**: NFD stored + percent-encoded NFC reference | `assetSearchStrings` percent-encodes *before* NFC-normalising; escapes are ASCII so normalisation can no longer reach them. Each half works alone; only the combination fails. |
| 10 | Page budget ignores **JSON escaping** | Budget counts stored UTF-8 bytes; a control char costs 6 bytes on the wire. 12 notes of U+0001 → a 37.7MB response, above the 32MiB the budget targets. No 500 (the RPC hop counts raw bytes) — not a blocker. |

Defect 8 is the more important lesson than the bug: it would have been a **total sync outage**
for this user's ~1,778-file workspace, strictly worse than the 32MiB jam it replaced. No test in
any round exercised more than 20 rows in one page.

### The third recurring failure mode

> **A page bounded by one dimension is unbounded in every other.** A byte budget replaced a row
> budget and nothing capped rows. When bounding a result set, enumerate every limit the engine
> imposes — bytes, rows, bound parameters, statement size — and bound against all of them.

Rounds 5, 6 and 7 each introduced a new defect while correctly fixing their assigned items. The
constant: every round's own suite was green while its bug was reproducible over real HTTP,
because the tests ran at toy scale. **Round 8's brief requires proof at thousands of rows.**

### Corrections to earlier entries in this note
- The M4 wiring test attribution was wrong. `batchVersion.test.ts`'s *"errorResponse wires typed
  errors…"* calls `errorResponse` directly and stays green when the router stops calling it. The
  wiring is genuinely covered by *"a malformed asset path segment reaching the router is a
  generic 500"*.
- The `routes/files.ts` md5 disclosure is confirmed innocent for the third time: `git diff -w` is
  byte-identical to `git diff`, zero whitespace-only hunks. Stop re-investigating it.

## Links
- [[202609032210-Shared-path-helper-change-silently-rewired-asset-GC-into-deleting-live-images]] — the recurring GC bug and its design rule
- [[202609031200-architecture-large-workspace-sync]] — O(workspace) vs O(change), and BUG-LW1
- [[202609021730-aptusfit-workspace-freeze-chokidar-emfile]] — the freeze that started this

## Conversation Source
**Session:** 43ef3796-9ec5-4ab7-8721-3675e372235f
**Date:** 2026-09-04 00:59 GMT+7
**Platform:** Claude Code (desktop)
