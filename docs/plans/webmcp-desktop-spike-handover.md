# Handover — desktop WebMCP origin spike (slice 3, local-doc-comments)

**Date:** 2026-08-27
**Status:** Superseded by Slice 4 (commit `82d9032`), which replaced the probe with the
real comment-tool surface. Conditions 1 and 2 below are now **verified**; condition 3
(the relay round-trip) is **still failing** and is the one open item — see the updated
verdict table and "What remains".

**Original status (2026-08-27):** Implementation committed; **spike NOT verified end-to-end** — the desktop
`file://` spike was superseded mid-flight. Priority shifted to the **OpenAI WebMCP
Challenge**, whose entry must be a public **website** testable in ChatGPT's in-app
browser / Chrome 149+ — an Electron app cannot qualify. No work was reverted; the
changes below are committed and available if the desktop path is ever resumed.

The original brief is `docs/plans/local-doc-comments.md`, section "Start with a
half-day spike on slice 3".

## What changed (all committed in `3936a1b`)

| File | Change |
|---|---|
| `apps/desktop/electron/main.ts` | Registered a second privileged scheme `app://` (`secure`, `standard`, `supportFetchAPI`, `corsEnabled`) alongside the existing `hubble-asset`. Added a `protocol.handle("app", …)` that serves files from the packaged renderer dir (`out/renderer` → `<bundle>/Contents/Resources/app.asar/out/renderer`). Content-hashed assets (`/assets/*.js|css|ttf|woff2|png|svg|mp4`) get `cache-control: immutable`; `index.html` gets `no-cache`. Swapped `window.loadFile(../renderer/index.html)` for `window.loadURL("app://mdly/index.html")` in the **non-dev** branch. Extended `assetContentType` for `.ttf/.woff/.woff2/.mp4/.ico/.map`. |
| `apps/desktop/package.json` | Added `@mcp-b/global@5.0.1` (WebMCP polyfill; installs BOTH `document.modelContext` and `navigator.modelContext`). |
| `pnpm-lock.yaml` | Lockfile entry for the above (only `@mcp-b/*` + `@modelcontextprotocol/*` lines added; verified the diff contains nothing else). |
| `apps/desktop/src/main.tsx` | Calls `setupWebmcpSpikeProbe()` at startup (non-fatal if the polyfill is absent). |
| `apps/desktop/src/webmcp.ts` | **New.** Imports `@mcp-b/global`; registers one trivial `mdly_origin_probe` tool (returns `window.origin`, `isSecureContext`, `href`); appends the relay embed script. |
| `apps/desktop/public/mcpb/embed.js` | **New.** Vendored `@mcp-b/webmcp-local-relay@5.0.1` browser embed. Must be served as a real `<script src>` (it reads `document.currentScript` and resolves `widget.html` relative to itself), so it cannot be npm-imported. |
| `apps/desktop/public/mcpb/widget.html` | **New.** Vendored relay widget (self-contained; no `widget.js` needed). |

The packaged `.app` was built successfully at
`apps/desktop/release/mac-arm64/mdly.app` (electron-builder `--dir`, exit 0,
Developer-ID signed). It was **not** launched at the time of writing; it has since been
launched (2026-09-02), which is what settled conditions 1-3 below.

## Pass conditions — verdict

| # | Condition | Verdict | Evidence / gap |
|---|---|---|---|
| 1 | Renderer loads from the new scheme in a **packaged** (non-dev) build | **VERIFIED** (2026-09-02) | The packaged app's renderer executes JS from `app://mdly/assets/index-CeRQJ4x2.js`. The `loadFile`→`loadURL` swap works; no blank screen from the scheme. |
| 2 | `window.isSecureContext === true` and a real tuple origin (`app://mdly`), not `"null"` | **Mostly verified** (2026-09-02) | Tuple origin confirmed — code runs from `app://mdly/...`, so the opaque `null` origin of `file://` is gone. The scheme is genuinely registered secure: the renderer helper's own command line carries `--secure-schemes=hubble-asset,app`. `isSecureContext` was never *read* at runtime, because the probe that would report it is only reachable through the relay, which is condition 3. |
| 3 | One registered WebMCP tool visible to an MCP client via `@mcp-b/webmcp-local-relay` | **FAILS** (2026-09-02) | The relay runs and accepts connections but reports `count: 0` sources — no mdly page ever registers with it. The renderer logs `[WebModelContext] Native WebMCP tool synchronization failed: [object DOMException]`. Leading (untested) hypothesis: `app://` is a **secure** scheme, and the relay widget connects over plain `ws://`, which a secure context blocks as mixed content. If that is the cause, the fix is a `wss://` relay or an exemption — not a change to the tool code. |

**This does not block agent access.** Slice 4 ships two transports precisely so that a
WebMCP failure is not fatal: the loopback MCP server (`apps/desktop/electron/mcpServer.ts`)
has no origin requirement and no relay, and is verified end-to-end over the real MCP wire
protocol in `apps/desktop/electron/agentEndToEnd.test.ts`. WebMCP is the path to a future
browser app, where a page cannot host an MCP server; the desktop does not depend on it.

## What remains

1. **~~Verify the packaged app in practice~~** — done (conditions 1-2 above).
2. **Diagnose the relay round-trip failure** — the one live blocker. Test the mixed-content
   hypothesis first: read `isSecureContext` and the DOMException's real `name`/`message`
   from the renderer (the current log stringifies it to `[object DOMException]`, which
   hides the actual cause), then decide between a `wss://` relay, a scheme exemption, or
   dropping the relay in favour of the loopback MCP server on desktop.
3. **Watch for `file://` stragglers** — the renderer uses `localStorage` (theme/font
   prefs). Changing origin means stored prefs won't be visible under `app://` — cosmetic,
   not blocking. The `hubble-asset://` iframe path is unchanged.
4. **~~Slice 4~~** — done in `82d9032`: `webmcp.ts` now publishes the real six-tool comment
   surface (`agentTools.ts`) instead of the probe, gated behind the Settings toggle. The
   `mdly_origin_probe` tool was deliberately KEPT as a diagnostic, and is exactly what item
   2 needs.
5. **Unrelated blocker discovered while verifying (2026-09-02)** — mdly's main process is
   currently unresponsive in both dev and packaged builds: the app starts, logs normally,
   then serves no window and answers no loopback HTTP request. It reproduces with agent
   access turned **off** (so the Slice 4 server never starts) and does **not** reproduce
   with a bare Electron 42.3.1 main using the same binary. This blocks in-app verification
   of both transports and is independent of everything in this document.

## Notes / risks

- The `mdly_origin_probe` tool and the whole `webmcp.ts` spike adapter are **inert in a
  website**: the OpenAI WebMCP Challenge needs a browser page. `@mcp-b/global` + the
  relay embed could be reused on a public site (embed.js/widget.html vendored in
  `public/mcpb/`), but the `app://` scheme work is Electron-specific and does not
  transfer.
- If the desktop path is dropped, consider reverting `3936a1b` wholesale in a future
  commit (not by checkout/restore) to keep the tree clean — or leave it; it is harmless
  and dev-mode (`ELECTRON_RENDERER_URL`) is unaffected.
