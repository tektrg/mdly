# Desktop App

Desktop app for mdly (TypeScript + Electron).

## Prerequisites

Install:

- [Node.js](https://nodejs.org/en/download)
- [pnpm](https://pnpm.io/installation)
- macOS desktop builds: Xcode Command Line Tools via `xcode-select --install`

## Development

From repo root:

```sh
pnpm install
pnpm dev:desktop
```

For Chrome DevTools MCP access:

```sh
pnpm dev:desktop:debug
```

The debug command exposes the Electron renderer over Chrome DevTools Protocol at `http://127.0.0.1:${HUBBLE_DESKTOP_DEBUG_PORT:-9222}`.

## Build

From repo root:

```sh
pnpm build:desktop
pnpm bundle:desktop
```

`bundle:desktop` creates macOS release artifacts under `apps/desktop/release/`.

## Distribution

The desktop app is macOS-only for now. Production updates use GitHub Releases
on `tektrg/mdly`. Each release should include:

- `latest-mac.yml`
- the generated `.zip`
- the generated `.dmg`
