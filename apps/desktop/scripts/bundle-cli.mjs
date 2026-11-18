#!/usr/bin/env node
// Bundles the `mdly` CLI (packages/cli/src/mdly.ts + @mdly/agent-hook) into one
// self-contained file plus a launcher, under .cli-bundle/, which electron-builder
// ships as extraResources -> Contents/Resources/cli. The launcher runs it with
// the app's own Electron binary as node, so `mdly watch` / `mdly mcp` work over
// ssh on a Mac with no node installed:
//   /Applications/mdly.app/Contents/Resources/cli/mdly watch <note.md>
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = path.join(desktopDir, ".cli-bundle");

// esbuild comes with vite (a desktop devDependency); resolve it through vite
// so pnpm's strict layout doesn't need a direct dependency.
const fromVite = createRequire(createRequire(import.meta.url).resolve("vite"));
const esbuild = await import(fromVite.resolve("esbuild"));

export const LAUNCHER = `#!/bin/sh
# mdly CLI launcher: runs the bundled CLI with this app's Electron as node.
# Works through symlinks; no node install needed.
self="$0"
while [ -L "$self" ]; do
	link="$(readlink "$self")"
	case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
dir="$(cd "$(dirname "$self")" && pwd -P)"
ELECTRON_RUN_AS_NODE=1 exec "$dir/../../MacOS/mdly" "$dir/mdly.js" "$@"
`;

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
await esbuild.build({
	entryPoints: [
		path.join(desktopDir, "..", "..", "packages", "cli", "src", "mdly.ts"),
	],
	outfile: path.join(outDir, "mdly.js"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "warning",
});
// Strip the source's `#!/usr/bin/env node` banner effect: the launcher, not
// a system node, runs this file. "type":"module" makes the .js ESM.
fs.writeFileSync(path.join(outDir, "package.json"), '{"type":"module"}\n');
fs.writeFileSync(path.join(outDir, "mdly"), LAUNCHER, { mode: 0o755 });
console.log(`[bundle-cli] wrote ${outDir}/{mdly,mdly.js}`);
