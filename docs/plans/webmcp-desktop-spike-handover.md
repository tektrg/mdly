# Handover — desktop WebMCP origin spike (slice 3, local-doc-comments)

**Date:** 2026-08-27
**Status:** Implementation committed; **spike NOT verified end-to-end** — the desktop
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
Developer-ID signed) — but **it was never launched** to verify behavior.

## Pass conditions — verdict

| # | Condition | Verdict | Evidence / gap |
|---|---|---|---|
| 1 | Renderer loads from the new scheme in a **packaged** (non-dev) build | **Not verified** | The `loadFile`→`loadURL` swap compiles and packages, and the built `out/renderer/index.html` uses relative asset paths (resolvable under the scheme). But the packaged app was never launched to confirm the window loads without a blank screen. |
| 2 | `window.isSecureContext === true` and a real tuple origin (`app://mdly`), not `"null"` | **Not verified** | The `app://` scheme is registered privileged/secure, which *should* yield a secure context + tuple origin, but no runtime check was performed. The `mdly_origin_probe` tool is the intended probe but was never called. |
| 3 | One registered WebMCP tool visible to an MCP client via `@mcp-b/webmcp-local-relay` | **Not verified** | Page side is wired (polyfill + tool + embed) and bundles cleanly, but the relay was never started and no MCP client ever connected. |

## What remains (if this path is resumed)

1. **Verify the packaged app in practice** — launch `release/mac-arm64/mdly.app`, open
   DevTools (or add a log) and confirm: window loads, `window.origin === "app://mdly"`,
   `isSecureContext === true`.
2. **Verify the relay round-trip** — start `npx @mcp-b/webmcp-local-relay` (loopback
   WebSocket 9333), then call `mdly_origin_probe` from an MCP client (e.g. via a small
   stdio MCP client; `webmcp_list_tools` / `webmcp_list_sources`).
3. **Watch for `file://` stragglers** — the renderer uses `localStorage` (theme/font
   prefs). Changing origin means stored prefs won't be visible under `app://` — cosmetic,
   not blocking. The `hubble-asset://` iframe path is unchanged.
4. **Slice 4** — replace the probe tool with the real comment-tool surface. The spike
   module is intentionally minimal.

## Notes / risks

- The `mdly_origin_probe` tool and the whole `webmcp.ts` spike adapter are **inert in a
  website**: the OpenAI WebMCP Challenge needs a browser page. `@mcp-b/global` + the
  relay embed could be reused on a public site (embed.js/widget.html vendored in
  `public/mcpb/`), but the `app://` scheme work is Electron-specific and does not
  transfer.
- If the desktop path is dropped, consider reverting `3936a1b` wholesale in a future
  commit (not by checkout/restore) to keep the tree clean — or leave it; it is harmless
  and dev-mode (`ELECTRON_RENDERER_URL`) is unaffected.
