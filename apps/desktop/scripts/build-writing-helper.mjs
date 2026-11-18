#!/usr/bin/env node
// Builds the Apple on-device model helper (native/writing-helper/main.swift)
// into native/build/mdly-writing-helper with `swiftc` (Command Line Tools is
// enough). electron-builder copies it to Contents/MacOS (`build.extraFiles`)
// and signs it with the app. Deployment target is macOS 12 with
// FoundationModels weak-linked, so the helper still starts on older macOS and
// reports `unsupported-os` instead of crashing at launch.
// Skipped (with a note) off macOS, where the writing tools fall back to the agent.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const source = path.join(desktopDir, "native", "writing-helper", "main.swift");
const outDir = path.join(desktopDir, "native", "build");
const output = path.join(outDir, "mdly-writing-helper");

if (process.platform !== "darwin") {
	console.log("[writing-helper] not macOS: skipping the Swift helper build");
	process.exit(0);
}
const upToDate =
	fs.existsSync(output) &&
	fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs;
if (upToDate) {
	console.log("[writing-helper] up to date");
	process.exit(0);
}
fs.mkdirSync(outDir, { recursive: true });
execFileSync(
	"xcrun",
	[
		"swiftc",
		"-O",
		"-target",
		"arm64-apple-macos12.0",
		"-Xlinker",
		"-weak_framework",
		"-Xlinker",
		"FoundationModels",
		source,
		"-o",
		output,
	],
	{ stdio: "inherit" },
);
console.log(`[writing-helper] built ${path.relative(desktopDir, output)}`);
