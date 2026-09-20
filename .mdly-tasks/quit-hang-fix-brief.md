# Task brief — fix the mdly quit hang (Cloud Sync watches 41k files)

You are working in `/Users/trungluong/01_Project/markdown-lite-mac/hubble-source`.

**Read `AGENTS.md` at the repo root first.** Its rules bind you — most importantly: a change is
not shipped until the packaged app is rebuilt and restarted, not merely until tests pass.

This repo is a **shared checkout — several agents work in it at once.** Never run `git stash`
(bare), `git reset --hard`, `git clean -f`, `git checkout -- <path>`, or `git push --force`.
Only touch the files this brief names. Commit your own slice when it is green; do not commit
anyone else's uncommitted work.

---

## The bug (already root-caused — do not re-investigate)

Quitting `/Applications/mdly.app` beachballs the app for **~4 minutes**. Measured twice on the
2026-09-17 21:55 build: 230 s and 229 s.

**Cause.** `defaultCreateWatcher` in `apps/desktop/electron/cloudSyncWiring.ts` (~line 320) runs
`chokidar.watch(workspaceRoot)` over the entire workspace. chokidar v4 dropped the native FSEvents
backend, so every watched path is a separate Node `fs.watch` handle — **one per file**, not per
directory. `resumeCloudSyncForGrantedRoots` starts this at every launch for every granted root.

Measured live in the packaged main process (A/B, same binary, minutes apart):

| Cloud Sync on the AptusFit workspace | live `FSWatcher` handles | open FDs | quit |
|---|---:|---:|---:|
| on  | **41,359** | 37,606 | **~230 s** |
| off | 0          | 118    | **0.91 s** |

The workspace has 29,122 files after the current prune list, of which 11,156 are
`fe/apps/mobile/ios/Pods/` CocoaPods C++ headers. **Only 3,684 are Markdown.** ~90% of the watch
budget is spent on files mdly can never sync.

### What is NOT the bug — leave all of this alone

- `main.ts:2445` `before-quit` → `stopAllCloudSync({ closeWatchers: false })` **works correctly.**
  A CDP probe wrapping `FSWatcher.prototype.close` in the live app recorded **zero** calls across a
  full 229 s quit. Do not "fix" it, do not revert it.
- The `subscriber.ts` handshake-race fix (`noopSocketErrorSink`, `CONNECT_TIMEOUT_MS`) is fine.
- There is no quit veto: no `will-quit`/`quit` handler, no `preventDefault` on quit, no renderer
  `beforeunload`, no awaited renderer IPC during quit.

Skipping `watcher.close()` did not remove the cost — libuv pays the same per-handle teardown at
process exit instead. **The only real fix is to stop creating so many handles.**

---

## Your fix — and only this fix

**Make the Cloud Sync watcher track only what Cloud Sync can actually sync: Markdown documents
and the sidecar paths it already special-cases.** Target: 41,359 handles → ~3,700 on this
workspace, with no change to *what* gets synced.

Work in `defaultCreateWatcher` / the `ignored` predicate in
`apps/desktop/electron/cloudSyncWiring.ts`. Keep `isWatchedSidecarPath` and
`isPrunedCloudSyncPath` behaviour intact — you are adding a filter, not replacing theirs.

### Explicitly out of scope — do not do these

- Do **not** widen `DEFAULT_CLOUD_SYNC_EXCLUDED_DIR_NAMES` (adding `Pods`, `build`, etc.).
  That list is user-visible sync scope, and excluding a folder may make the sync engine treat
  those files as remote deletions. Different change, different risk, not now.
- Do **not** swap chokidar for `@parcel/watcher` or a recursive `fs.watch`. That structural fix is
  recorded separately; it is not this task.
- Do **not** touch the MCP server shutdown, the crash-trace debugger detach, or the WebMCP
  renderer error. All logged separately.
- Do **not** change any workspace's `.hubble/config.json`.

### Traps to check before you write code

1. **`ignored` is called for directories too.** chokidar will not descend into a directory whose
   `ignored` returns true. A naive "ignore anything that isn't `*.md`" prunes the entire tree and
   silently breaks sync. Directories must stay walkable; only *files* get the extension filter.
2. **Verify nothing else depends on the watcher seeing non-Markdown files.** Read the change-event
   handlers and the sync walk. If the sync engine discovers files independently, you are safe. If
   any code path relies on a watcher event for a non-Markdown file, say so and stop rather than
   shipping a silent regression.
3. Use the same document-extension helper the rest of the codebase uses (`hasDocumentExtension` is
   used by the active-file watcher in `main.ts`) rather than hardcoding `.md`.

---

## Pass conditions — all of them, with evidence

1. `pnpm build:desktop` green, including typechecks.
2. The cloudSync vitest suite green (it was 55 cases). **Add tests** that prove:
   a non-Markdown file under the workspace is not watched; a Markdown file still is; a Markdown
   file in a nested directory still is (i.e. directories are still traversed); the sidecar paths
   (`.mdly/comments`, `.mdly/history`) still behave as before.
3. **Live measurement on the real packaged app** — tests alone do not close this task.

### How to measure (the normal profiler does NOT work here)

`sample` and `spindump` return an **empty call graph** on the signed app — the task port is denied.
Do not waste time on them. Use the main-process inspector instead:

```
/Applications/mdly.app/Contents/MacOS/mdly --inspect=9229
curl -s http://127.0.0.1:9229/json/list     # -> webSocketDebuggerUrl
```

Drive `Runtime.evaluate` over that WebSocket from a small Node script (`ws` resolves under
`node_modules/.pnpm/ws@*/node_modules/ws`) and evaluate:

```js
(()=>{const h=process._getActiveHandles();const c={};for(const x of h){const n=x?.constructor?.name||typeof x;c[n]=(c[n]||0)+1;}return {total:h.length,counts:c};})()
```

Measure with the **AptusFit workspace's Cloud Sync left ON** (it is on now — do not change it),
waiting ~60 s after launch for the watcher to finish its walk.

**PASS:** live `FSWatcher` count **under 5,000** (was 41,359) AND wall-clock quit **under 5 s**
(was ~230 s). Time the quit from `osascript -e 'tell application id "com.tektrg.mdly.desktop" to quit'`
until the pid disappears.

4. Sync must still work end-to-end: create/edit a Markdown file in a synced workspace and confirm
   the watcher still fires and the sync path still runs. A fast quit with broken sync is a failure.

---

## Report back

When done, reply with: the measured before/after numbers, the files you changed, the tests you
added, and anything you found that contradicts this brief. If a pass condition cannot be met,
say which one and why — do not report success on a partial result.

Prior investigation, if you want the detail:
`../memory/Areas/editor-architecture/202609172232-mdly-prod-quit-hang-returns---41k-chokidar-per-file-watchers-from-Cloud-Sync.md`
