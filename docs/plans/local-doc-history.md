# Plan: Local Document History (versions + diff)

**Status:** Approved — progress tracked per slice below. (2026-08-14 not-started → 2026-08-27: slices 1 and 3 shipped, slice 2 pending → 2026-08-28: slice 3's review UX revised, see gate below.)
**Scope of this doc:** slices 1–3, all in this repo. A second consumer adopts the
same packages afterwards (see *Second-consumer constraints*).

## What the user gets

> Claude Code edits a note in your folder. mdly notices, snapshots it, and applies
> the change automatically — no dialog to act on first. If it wasn't wanted, one
> **Undo** reverts the whole file back to what you had.

Plus the ordinary case: a timeline of past versions of any note, readable offline,
with no account and no server.

## Decisions already locked

| Question | Decision |
|---|---|
| Where history lives | In the workspace folder, `.mdly/history/` |
| Cross-device | Carried by whatever syncs the folder (iCloud/Drive/git). No backend. |
| When a version is cut | Around external/agent writes, plus idle human sessions |
| Review granularity | **Revised 2026-08-28: whole-file auto-apply + Undo**, not per-region accept/reject (see gate below) |
| Comments | **Out of scope here.** Separate follow-on feature. |
| Cloud | **Not on the critical path.** Everything here works offline. |

## Why this repo first

- The kit is linked as `workspace:*`, so kit changes hot-reload. The second
  consumer vendors the kit as a tarball, where every change costs a release plus a
  re-vendor.
- One write choke point in the desktop main process; autosave already lives inside
  the kit.
- The active file is already watched — the external-write signal exists today.
- Notes here are plain Markdown. No media, no generated sidecar artifacts, no
  hidden-canonical/visible-copy duality.

---

## Architecture

### On-disk store — `.mdly/history/`

| Path | Contents | Mutability |
|---|---|---|
| `objects/<ab>/<hash>` | one gzipped copy of a note's content | **write-once, never modified** |
| `log/<encoded-path>.jsonl` | one line per revision | **append-only, never rewritten** |

That table is the entire multi-writer safety argument:

- **Immutable blobs cannot fork meaningfully.** Sync engines duplicate files that
  get *modified*. A file never modified after creation either syncs or doesn't; a
  duplicate would be byte-identical and harmless.
- **Append-only logs merge by concatenation.** If sync produces `log 2.jsonl`, the
  reader globs every sibling variant and merges by revision id. Nothing lost, no
  repair step, no user-visible conflict.
- **A single `history.json` would corrupt under concurrent writers.** That design
  is out.

### Revision record

One JSON object per line:

| Field | Meaning |
|---|---|
| `id` | sortable unique id |
| `hash` | content hash; addresses the blob under `objects/` |
| `at` | timestamp |
| `by` | `{ kind: "human" \| "agent" \| "external", id, label }` |
| `cause` | `external-write` \| `idle-session` \| `manual` \| `import` \| `restore` |
| `bytes` | uncompressed size (lets a future prune policy reason without reading blobs) |
| `prev` | previous revision id |

`prev` matters: it lets a merged forked log be re-linearized correctly even when
two devices' clocks disagree. Never order by timestamp alone.

`by.kind = "external"` is the honest answer for a write that arrived from outside
the app. We can record *that* something else changed the file, not *which* agent.

### When a revision is cut

- **Immediately on an external write** (watcher fires). This is the primary
  trigger in this repo, and it is what makes the review feature a by-product of
  the write path rather than a second feature.
- **Human edits: 3 minutes after typing stops.** Plus a forced cut after 30
  minutes of continuous editing, on app quit, on workspace switch, and on closing
  a file.
- **Skipped entirely when content is byte-identical** to the previous revision.
- **Markdown only.** Never version binary assets.

Known and accepted gap: type for two minutes, crash, and history has nothing.
Undo covers that window; history does not.

### Diff and accept/reject

**Revised 2026-08-28:** this machinery is no longer used by the desktop app's
external-change handling (see gate below) — the app now auto-applies external
edits and offers one whole-file Undo. It's kept here because slice 2's CLI
(`diff <note> --json`, the agent-facing surface) still needs it.

- Line-level comparison, with word-level refinement inside changed areas **for
  display only**.
- A **region** is a contiguous run of changed lines plus context. Each region gets
  its own accept/reject.
- The merged result is built by walking the comparison and picking a side per
  region — **no offset arithmetic**, so it is correct by construction. This is why
  per-region review is days of work rather than weeks.
- Library: `diff` (jsdiff) — MIT, small, identical behaviour in Node and browser,
  so the CLI and the UI can never disagree about what changed.

### Package layout

| Package | Contents | Notes |
|---|---|---|
| `packages/doc-history` | store, revision log, diff, region merge | **New.** Written against a filesystem interface, not Node directly, so a second consumer can supply its own. No UI, no Electron. |
| `packages/workspace-kit` | diff view, revision timeline | Kit already owns autosave — the idle-cut debounce belongs here too. |
| `packages/cli` | `history`, `diff`, `restore` verbs | Currently knows only `cloud`; this is additive. |
| `apps/desktop` | wires the write hook and the watcher into the store | |

---

## Slices

Each slice is independently shippable. 1 and 2 land together — there is no reason
to ship a store with no way to read it.

**Status per slice (updated 2026-08-27):**

| Slice | State |
|---|---|
| 1 — store (`@mdly/doc-history`) | **Shipped** (`packages/doc-history` exists) |
| 2 — read side + CLI (`history`/`diff`/`restore`) | **Not done.** `packages/cli` still knows only `cloud` |
| 3 — diff UI in the kit | **Revised, in progress.** Per-region review UI (`DiffReviewPanel`, `ExternalChangeReviewDialog`) removed; replaced with auto-apply + whole-file Undo. See gate below. |

### Slice 1 — the store *(size: M)*

Build `packages/doc-history`; hook the desktop write handler, the kit's autosave
debounce, and the external-file watcher.

**Verified by:** unit tests for cut rules, dedupe, rename chains, and forked-log
merge. Explicitly test a *forked* log (`log 2.jsonl` created by hand) and confirm
the reader merges it without data loss.

### Slice 2 — read side and CLI *(size: S)*

| Command | Does |
|---|---|
| `history <note>` | list revisions: time, author, cause, size |
| `diff <note>` | working file vs last revision |
| `diff <note> --rev <id>` / `--rev A..B` | any two points |
| `diff <note> --json` | machine-readable regions — **the agent-facing surface** |
| `restore <note> --rev <id>` | roll back, cutting a revision of current state first, so restore is itself reversible |

**Verified by:** fixture-based diff tests; restore round-trip; a run against a
real notes folder.

### Slice 3 — diff UI in the kit *(size: M)*

Revision timeline, plus external edits auto-apply with a whole-file Undo pill
(revised 2026-08-28 — was per-region accept/reject; see gate below).

**Verified by:** kit unit tests plus a manual pass in the desktop dev app —
external write (edit a note with another tool while mdly has it open) must
auto-apply, and Undo must restore the exact prior bytes.

### Slice 4 — second consumer *(tracked in that repo, not here)*

Adopt `doc-history` and the kit's diff view; add that app's own write hooks; run a
cloud-sync-specific soak. Gated on unrelated work in that repo.

---

## Second-consumer constraints

The other consumer of these packages has properties mdly lacks. The interface must
accommodate them **from the start**, even though only mdly implements them first,
or it will have to bend later:

1. **A logical document can span more than one file** (a canonical copy plus a
   visible copy). History must key on the logical document, not blindly on path.
2. **Documents have stable ids independent of path**; renames are frequent and
   driven by title changes. Path-keyed logs need a rename chain — include a
   `rename` record type in slice 1 even though mdly barely exercises it.
3. **Generated vs user-authored content is distinguished**, and generated content
   may want different retention. Carry an origin field on the revision.
4. **Its workspace lives in iCloud with a known file-forking history.** Never relax
   the immutable/append-only rules for convenience — that repo depends on them.
5. Its workspace holds large media that must **never** be versioned. Keep the
   Markdown-only filter in the package, not in the app.

A rename-chain conformance test belongs in `packages/doc-history` from slice 1.

---

## Risks

| Risk | Standing |
|---|---|
| Sync-fork tolerance is unproven in the field | Design is fork-*tolerant*, not fork-*preventing*. mdly folders are usually ordinary directories, so the real test happens at the second consumer. Keep the design regardless. |
| File count, not bytes | ~3KB per revision compressed. 200 notes × 20 revisions ≈ 12MB — bytes are a non-issue. Thousands of *small files* in a sync engine is the untested part. Packing old objects into archives is the v2 answer if it bites. |
| Renames | Most likely place for a subtle bug. Covered by a conformance test. |
| Evicted/dataless files | A cloud sync engine can keep a blob present-but-not-downloaded. `readRevision` must surface "fetching…", never an error. |
| Public repo | This ships MIT on public npm. Accepted precedent (the editor already did). |

## Open items

1. **Retention policy is unspecified.** "Keep forever" is fine for years at
   realistic volume. Decide before it becomes a support question.
2. **The 3-minute idle window is a guess.** Start there; make it a setting only if
   it annoys someone.
3. **Comments** anchor into the same text-matching machinery this builds. Do not
   design the anchor format here, but do not make it impossible either.

---

<details>
<summary>**Gate cleared — slice 3 review UX simplified to auto-apply + Undo** — gate: `Keep the in-progress rewrite (auto-apply + whole-file Undo) or revert to the approved per-region review UI?` · asked 2026-08-28T00:00:00+00:00</summary>

## Local doc history — slice 3 direction change

Found uncommitted work rewriting how mdly handles a note being edited outside
the app (e.g. by Claude Code) while it's also open in mdly. It deletes
`ExternalChangeReviewDialog` and `DiffReviewPanel` and replaces the whole
conflict/review flow with: the external edit auto-applies immediately, and one
**Undo** pill restores the whole file to what it was.

### Why this needed a decision before continuing

This directly reverses what this doc had marked **Approved** and **Shipped**:
the original promise was a badge — *"changed outside the app — review"* — that
opened a diff and let you accept or reject each changed region individually.
The new code instead never blocks or asks; it just applies the change and
gives you one way back out.

### The call

- **Recommended: keep the new auto-apply + Undo model.** Far less code and far
  fewer edge cases (no more "conflict" vs "review" distinction, no per-region
  merge state to keep consistent). Trade-off: if an outside tool changes
  several things at once and only part of it is wanted, there's no way to
  keep some and discard others — Undo is all-or-nothing for that file.
- **Alternative: revert to per-region accept/reject**, restoring the deleted
  dialog/panel. Matches what was already documented as shipped, but keeps the
  more complex code path — the diff being replaced contains detailed
  bug-fix-style comments (e.g. referencing issue tags like `R12/QA1a`, a
  write-echo race) suggesting the old flow had real, hard-to-fix bugs.

**Decision: keep the auto-apply + Undo model.** This doc's "What the user
gets," decision table, and slice 3 status above are updated accordingly.

</details>

