# Plan: Local Document Comments (offline-first, agent-accessible via WebMCP)

**Status:** Approved, not started — 2026-08-27
**Builds on:** `docs/plans/local-doc-history.md` (slices 1 and 3 shipped: `@mdly/doc-history` + the kit diff/revision UI)
**Deliberately deferred:** cloud sync of comments. See *Phase 2*.

## What the user gets

> Select text in a note, leave a comment. Your agent — reached through WebMCP from
> Claude Code — reads the open threads, edits the document, replies, and resolves.
> Entirely offline. No account, no server, no real-time anything.

## Locked decisions

| Question | Decision |
|---|---|
| Primary collaborator | **The user's own AI agent.** Human teammates are a later, additive concern |
| Comment model | Plain threads; the agent is a participant (not a separate task type) |
| Where comments live | Files inside the workspace — `.mdly/comments/<docId>.jsonl` |
| Agent access | **WebMCP**, via `@mcp-b/global` in the page and `@mcp-b/webmcp-local-relay` in the MCP client |
| Cloud sync | **Out of scope for Phase 1.** Arrives later as part of whole-workspace sync |
| Agent triggering / orchestration | **Out of scope entirely.** The app stores and syncs comments; it never wakes an agent |

## Phase 1 — local only

| # | Ships | Size |
|---|---|---|
| 1 | `@mdly/doc-comments` — append-only event log, anchoring, orphan handling. Pure logic, no UI, no Electron | M |
| 2 | Kit comment UI — comment mark, gutter, thread panel | M |
| 3 | **Prerequisite:** serve the renderer from a privileged scheme instead of `file://` | S |
| 4 | WebMCP adapter — register the tool surface, wire the relay | S |

Slice 3 gates slice 4 only. Slices 1–2 are a complete feature without it.

### Start with a half-day spike on slice 3

`file:` pages report an opaque `null` origin, and the WebMCP relay's descriptor
execution path **rejects opaque origins**. Packaged mdly currently loads the
renderer with `window.loadFile(...)`, so WebMCP cannot work in the shipped app.

The fix is already a proven pattern in this codebase: `hubble-asset` is registered
via `protocol.registerSchemesAsPrivileged` with `secure`, `standard`,
`supportFetchAPI`, and `corsEnabled`, and its handler's own comment notes that
"HTML apps use this protocol as their base URL, so relative scripts, stylesheets,
images, and fetches resolve to granted files." Register a second scheme for the
renderer and swap `loadFile` for `loadURL`.

**Spike pass conditions:**

1. The renderer loads from the new scheme in a packaged (non-dev) build.
2. `window.isSecureContext === true` and the origin is a real tuple origin
   (e.g. `app://mdly`), **not** opaque `null`.
3. One trivial registered tool is visible to an MCP client through
   `@mcp-b/webmcp-local-relay`.

If (2) or (3) fails, stop and report before slices 1–2 build around it. A local MCP
server in the Electron main process is the known fallback — it has no origin
requirement — but it is not WebMCP and changes the plan.

## Phase 2 — later, and NOT a comments project

Wiring `packages/sync` into the desktop app, adding auth to the Convex backend, and
deploying a browser surface is **whole-workspace sync work**. Comments ride along
for free — provided Phase 1 honours the three constraints below.

Known gaps that belong to that phase, recorded here so they are not rediscovered:

- `packages/sync` is **not wired into the desktop app at all**; cloud sync is
  CLI-only today (`hubble cloud sync` / `hubble cloud watch`).
- The Convex schema has **no users or auth table** — workspaces are keyed by *name*,
  so anyone who guesses a name can read it. This must be fixed before any browser
  surface is publicly reachable.
- `apps/www` (the Convex-backed, kit-based browser client) has **no deploy target**.

## The three constraints that keep Phase 2 free

Honour these and comment sync later costs one file-filter change. Violate any one
and Phase 2 becomes a bespoke comment-sync project.

1. **Comments are files inside the workspace.** `.mdly/comments/<docId>.jsonl`.
   Never in Electron's app-private storage — workspace sync would never see them.
2. **Every mutation is an appended event**, including resolve and reopen. Never
   rewrite an existing line. The reader globs forked sibling logs **and**
   `.conflict-*` copies, merging by event id. This is what makes last-writer-wins
   file sync non-destructive for comments, so no comment-aware merge logic is ever
   needed.
3. **No field may assume a server.** No server-assigned ids, no server sequence
   numbers, no `syncedAt`. Ids are generated locally; ordering comes from the event
   id plus a previous-event pointer.

### A bonus that follows from constraint 1

Because comments are plain files in the workspace folder, a workspace kept in
iCloud or Dropbox **already carries comments to another Mac** — today, with no
Convex, no auth, and no deploy. The append-only, fork-tolerant design is exactly
what makes riding a naive file-syncer safe.

Precisely: that is free multi-**Mac** sync, not free multi-**device** sync. A phone
browser cannot reach iCloud Drive files, so web and mobile still wait for Phase 2.

## Architecture

### Storage

One append-only event log per document, keyed by the docId `@mdly/doc-history`
already assigns — so comments survive renames for free. Reuses that package's
JSONL fork-merge reader, id generator, and path/rename index.

Event kinds: `thread-opened`, `replied`, `resolved`, `reopened`.

**Comments never touch the `.md` file.** An agent rewriting a document cannot
destroy comments, and writing a comment does not cut a spurious revision.

### Anchoring — by revision replay

A comment records the **revision it was written against**. That revision's exact
bytes are still in the object store, so re-anchoring means replaying the existing
`diffRegions` from that revision to the current text and carrying the offset
forward. This is deterministic where fuzzy quote-matching is a guess.

Fallbacks, in order:

1. Region replay from the recorded revision (primary).
2. Quote plus leading/trailing context match, if the revision blob is unavailable.
3. **Orphaned** — surfaced in an explicit list. Never silently repositioned onto
   different text.

### Author identity

Reuse `RevisionAuthor` from `@mdly/doc-history` verbatim:
`{ kind: "human" | "agent" | "external", id, label? }`.

There is no authentication in mdly. An agent-attributed comment is trusted only
because it arrived through the local relay. Do not present it as verified.

### WebMCP tool surface

| Tool | Annotations |
|---|---|
| `list_threads`, `read_thread` | `readOnlyHint` + **`untrustedContentHint`** |
| `create_thread`, `reply`, `resolve` | write |
| `get_diff`, `list_revisions` | `readOnlyHint` |

**`untrustedContentHint: true` is mandatory on anything returning comment text.**
Chrome's own guidance names comments and reviews as the canonical example of
content that can hijack an agent: tool output is model-read text, so a comment is a
prompt-injection vector by construction. The hint is what lets a client spotlight
or sandbox it instead of treating it as instruction.

Entry point is `document.modelContext` in the current spec; older material says
`navigator.modelContext`. Use a shim for both.

Note the scope limit: WebMCP tools belong to a document and are unregistered when
it unloads. Tools reflect the **open** document, and no tools exist when no editor
window is open. A workspace-wide sweep needs its own tool.

### Reuse notes

- The kit already has range-decoration precedent in `FindReplaceExtension`,
  `FakeSelectionExtension`, and `StoredMarksDecorationExtension`. Comment
  highlighting should follow those patterns rather than inventing a new one.
- The kit's existing diff UI (`src/history/`) is plain React, not ProseMirror, so
  there is no in-editor decoration layer there to reuse.

## Cross-repo hazard

`@mdly/workspace-kit` is vendored into a second, private consumer as a tarball.
**Gate the comment UI behind an opt-in prop** so that consumer does not inherit a
half-wired feature on its next vendor bump — the same discipline as the existing
`chrome` prop.

## Risks

| Risk | Standing |
|---|---|
| Prompt injection through comment text | Inherent to the feature. Mitigated by the annotations above, not eliminated |
| Orphaned anchors after large rewrites | Reduced by revision replay; cannot be eliminated. Must be a visible state, never a silent mis-anchor |
| WebMCP spec churn | It is a W3C Community Group draft, Chrome-only, with near-zero real deployment. Keep it as one adapter behind a fixed tool contract |
| The `file://` origin | The only genuine unknown in Phase 1. The spike retires it in half a day |
| Log growth | Comment logs grow forever. Fine for years at realistic volume |

## Open items

1. **Retention policy** for comment logs — decide before it becomes a support question.
2. **Do comments ever travel with a shared `.md` file?** Currently no, sidecar only.
3. `docs/plans/local-doc-history.md` still reads "Approved, not started" although
   slices 1 and 3 shipped. Correct it so agents do not read it as current.
4. Project memory assumes a mobile port wraps `apps/notion-web`; the remote surface
   chosen for Phase 2 is `apps/www`, which would make **www** the wrap target.
