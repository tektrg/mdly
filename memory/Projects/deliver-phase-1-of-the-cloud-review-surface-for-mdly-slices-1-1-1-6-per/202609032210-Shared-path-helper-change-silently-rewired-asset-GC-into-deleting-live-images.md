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
