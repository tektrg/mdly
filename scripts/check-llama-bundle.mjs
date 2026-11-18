#!/usr/bin/env node
// Proves a packaged mdly.app can load the local writing model runtime:
// runs the app's OWN Electron binary as node (ELECTRON_RUN_AS_NODE=1), imports
// node-llama-cpp from Contents/Resources/llama/node_modules, and loads the
// prebuilt Metal binary via getLlama({ build: "never" }) — no model file needed.
// Usage: node check-llama-bundle.mjs <path/to/mdly.app>   (exit 1 on failure)
// 2026-11-18: the installed app shipped without ansi-escapes and with the
// metal binary as a ".moved" placeholder, so the dot never worked when packaged.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const app = process.argv[2];
if (!app) {
	console.error("usage: check-llama-bundle.mjs <mdly.app>");
	process.exit(2);
}
const fail = (msg) => {
	console.error(`[llama-check] FAILED ${app}: ${msg}`);
	process.exit(1);
};
const macos = path.join(app, "Contents", "MacOS");
const exe = fs.existsSync(macos) ? fs.readdirSync(macos)[0] : null;
if (!exe) fail("no executable in Contents/MacOS");
const modules = path.join(
	app,
	"Contents",
	"Resources",
	"llama",
	"node_modules",
);
const entry = path.join(modules, "node-llama-cpp", "dist", "index.js");
if (!fs.existsSync(entry)) fail(`missing ${entry}`);
const bins = path.join(modules, "@node-llama-cpp", "mac-arm64-metal", "bins");
if (!fs.existsSync(bins)) fail(`missing ${bins}`);

const probe = `
const m = await import(${JSON.stringify(pathToFileURL(entry).href)});
const llama = await m.getLlama({ build: "never", gpu: "metal", progressLogs: false });
console.log("LLAMA_OK gpu=" + llama.gpu);
await llama.dispose();
process.exit(0);`;
const r = spawnSync(
	path.join(macos, exe),
	["--input-type=module", "-e", probe],
	{
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		encoding: "utf8",
		timeout: 120_000,
	},
);
const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
if (r.status !== 0 || !/LLAMA_OK/.test(r.stdout ?? ""))
	fail(`import/getLlama failed (exit ${r.status}):\n${out}`);
console.log(`[llama-check] OK ${out.match(/LLAMA_OK.*/)[0]}`);
