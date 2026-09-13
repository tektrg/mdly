# 202609032210 Shared path helper change silently rewired asset GC into deleting live images

**Status:** caught in adversarial QA before deploy (fix round 3 dispatched). Never reached production.

## What happened

Fixing a path-traversal hole in the cloud-sync Worker, an agent moved
`normalizeWorkspacePath` out of `apps/www/worker/orphanAssets.ts` into a new shared
`apps/www/worker/paths.ts` — and, while moving it, **tightened its semantics**: per-segment
`.trim()`, and `null` for a whitespace-only segment.

That function has two consumers, not one:

| Consumer | What it does with the result |
|---|---|
| write path (the intended target) | canonicalise an incoming file path before storing it |
| `referencedAssetPaths` | decide which R2 objects a note still references |

`cron.ts` **deletes** every R2 object `referencedAssetPaths` fails to account for. Tightening
the shared helper therefore changed what counts as "referenced":

```
stored asset : "note.assets/ shot.png"
markdown ref : ![shot](note.assets/%20shot.png)
refs found   : ["note.assets/shot.png"]    <- trimmed, no longer matches
orphans      : ["note.assets/ shot.png"]   <- eligible for deletion
```

An asset under a directory named `" "` normalises to `null`, dropping its reference entirely.
Both matched correctly before the change. The GC grace period does not save them: a
persistently-referenced asset is re-flagged on **every** nightly scan.

Leading and trailing spaces in filenames are legal on macOS and Linux, so this is reachable
with ordinary user data — no attacker, no malformed client.

## Why it was missed

- The change was reviewed as a **security fix** ("canonicalise paths, block `../`"), and both
  the brief and the implementing agent reasoned only about the write path.
- The helper's *other* caller was in a different file with an unrelated name (`orphanAssets`),
  so nothing in the diff hinted at a deletion path.
- The brief itself pointed the agent at `normalizeWorkspacePath` as the thing to reuse —
  the instruction created the coupling.
- Two earlier QA rounds had already passed on this delivery; neither covered asset GC,
  because neither round had touched it. **The regression was introduced by the fix for the
  findings of the previous round.**

## The rule

**A shared helper's semantics are an interface. Changing them is a change to every caller,
including the ones the diff does not mention.** When a fix requires stricter behaviour, add a
*new* stricter function for the calling site that needs it and leave the shared one alone —
two functions, two jobs. Tightening in place is only safe after enumerating every consumer
and deciding the new behaviour is correct for each.

Corollary for briefs: naming an existing function as the one to "reuse" invites exactly this.
Say explicitly whether it may be modified in place or must be wrapped.

Corollary for review scope: a fix round's blast radius is **not** the set of files the brief
named. Grep every symbol the diff touched for other callers before signing off.

## Update 2026-09-04 — it recurred twice more, on different axes

Same bug — the asset GC deleting images a live note references — survived **three** fixes,
each closing a different axis. Recorded because the shape is the lesson, not any one axis:

| Round | Axis closed | What still deleted live images |
|---|---|---|
| 4 | structural path normalisation (`./`, `//`, `\`) | folder not named `*.assets` |
| 5 | the `*.assets` folder gate, `#`/`?` encoding | **reference syntax** |
| 6 | (in flight) | — |

Round 5's matcher used `visit(tree, "image")`, so it saw only inline `![](…)`. Reference-style
links, collapsed references, and **HTML `<img src=…>`** were invisible — all three reproduced
end-to-end being tombstoned and deleted from R2. `<img>` is routine in agent-generated
Markdown, which is this product's entire input. Separately, rows stored before round 4 are
non-canonical, and the matcher only ever emits canonical paths, so *referenced* legacy rows
were tombstoned too.

### The rule that should have been applied at round 4

> **A destructive operation must fail toward keeping data.** Deriving "is this still
> referenced?" by enumerating the syntaxes a reference might take is unbounded — every round
> finds another one. Derive it from a check that cannot miss: does the raw note text contain
> this path at all?

A raw-content containment scan is syntax-agnostic and over-retains (a path mentioned in prose
keeps its asset alive). Over-retaining costs pennies of storage; over-deleting destroys the
user's originals, because the tombstone propagates to the desktop and unlinks the local file.

**Test for this class:** when a predicate gates deletion, ask *what happens when the predicate
is wrong*. If a false negative deletes data, the predicate must be the conservative kind
(containment, allow-list of what may be deleted) rather than the exhaustive kind (parse every
form). Three rounds of whack-a-mole is the symptom of having picked the exhaustive kind.

### Second recurrence of the consumer-check failure

Round 5 changed what `totalOps` counts on the shared `SyncPlan`, which broke
`apps/desktop/electron/cloudSyncWiring.ts` — a workspace with a permanently-rejected file
never reports `done`. Same root cause as the original note above: a shared shape changed
without enumerating its consumers, this time across a package boundary the round was told not
to edit. Grepping consumers is now an explicit done-criterion in every brief.

## Related, same delivery

The same round also fixed two defects onto `/api/files/batch` — an endpoint with **zero
client callers** — while `/api/files`, the route the desktop app and CLI actually use, kept
both. Same underlying failure: acting on the brief's literal wording without checking which
code path is live. See [[202609031200-architecture-large-workspace-sync]].

## Links
- [[202609031200-architecture-large-workspace-sync]] — the O(workspace) analysis and BUG-LW1
  (quadratic row reads) whose fix this round was hardening
- [[202609021730-aptusfit-workspace-freeze-chokidar-emfile]] — the freeze that started this
  workstream

## Conversation Source
**Session:** 43ef3796-9ec5-4ab7-8721-3675e372235f
**Date:** 2026-09-03 22:10 GMT+7
**Platform:** Claude Code (desktop)
