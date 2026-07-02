#!/usr/bin/env node
// Builds mdly.app as a real Electron app bundle. The app is a tiny
// launcher that delegates to scripts/launch-dev.sh, which remains the source of
// truth for starting the tmux dev server and opening logs.

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(scriptDir, "..");
const desktopDir = path.join(repoDir, "apps", "desktop");
const desktopRequire = createRequire(path.join(desktopDir, "package.json"));

const appName = "mdly";
const bundleId = "com.benholmes.hubblemd.desktop.dev.launcher";
const outApp = path.join(repoDir, `${appName}.app`);
const legacyOutApp = path.join(repoDir, "Hubble Dev.app");
const iconSource = path.join(repoDir, "apps", "desktop", "assets", "icon.icns");
const launchScript = path.join(repoDir, "scripts", "launch-dev.sh");

function run(command, args, options = {}) {
	execFileSync(command, args, { stdio: "inherit", ...options });
}

function electronAppPath(executablePath) {
	const marker = `${path.sep}Electron.app${path.sep}`;
	const markerIndex = executablePath.indexOf(marker);
	if (markerIndex === -1) {
		throw new Error(
			`Electron executable is not inside Electron.app: ${executablePath}`,
		);
	}
	return executablePath.slice(0, markerIndex + "Electron.app".length + 1);
}

function upsertPlistValue(plistPath, key, value, type = "string") {
	try {
		run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plistPath], {
			stdio: "ignore",
		});
	} catch {
		run("/usr/libexec/PlistBuddy", [
			"-c",
			`Add :${key} ${type} ${value}`,
			plistPath,
		]);
	}
}

function signApp(appPath) {
	try {
		run("/usr/bin/codesign", ["--remove-signature", appPath], {
			stdio: "ignore",
		});
	} catch {
		// Unsigned bundles are fine; the force-sign below handles both cases.
	}
	run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", appPath]);
}

async function main() {
	if (!existsSync(launchScript)) {
		throw new Error(`Missing launcher script: ${launchScript}`);
	}
	if (!existsSync(iconSource)) {
		throw new Error(`Missing icon: ${iconSource}`);
	}

	const electronExecutable = desktopRequire("electron");
	const sourceApp = electronAppPath(electronExecutable);

	rmSync(outApp, { force: true, recursive: true });
	rmSync(legacyOutApp, { force: true, recursive: true });
	run("/usr/bin/ditto", [sourceApp, outApp]);

	const contentsDir = path.join(outApp, "Contents");
	const macosDir = path.join(contentsDir, "MacOS");
	const resourcesDir = path.join(contentsDir, "Resources");
	const plistPath = path.join(contentsDir, "Info.plist");
	const sourceExecutable = path.join(macosDir, "Electron");
	const appExecutable = path.join(macosDir, appName);

	if (existsSync(sourceExecutable)) {
		renameSync(sourceExecutable, appExecutable);
	}

	await copyFile(iconSource, path.join(resourcesDir, "mdly.icns"));

	upsertPlistValue(plistPath, "CFBundleIdentifier", bundleId);
	upsertPlistValue(plistPath, "CFBundleName", appName);
	upsertPlistValue(plistPath, "CFBundleDisplayName", appName);
	upsertPlistValue(plistPath, "CFBundleExecutable", appName);
	upsertPlistValue(plistPath, "CFBundleIconFile", "mdly.icns");
	upsertPlistValue(
		plistPath,
		"LSApplicationCategoryType",
		"public.app-category.developer-tools",
	);
	upsertPlistValue(
		plistPath,
		"NSAppleEventsUsageDescription",
		"mdly opens Terminal to show the tmux dev server logs.",
	);

	const defaultApp = path.join(resourcesDir, "default_app.asar");
	rmSync(defaultApp, { force: true });

	const launcherAppDir = path.join(resourcesDir, "app");
	rmSync(launcherAppDir, { force: true, recursive: true });
	mkdirSync(launcherAppDir, { recursive: true });
	writeFileSync(
		path.join(launcherAppDir, "package.json"),
		JSON.stringify(
			{ name: "mdly-dev-launcher", version: "0.0.1", main: "main.js" },
			null,
			2,
		),
	);
	writeFileSync(
		path.join(launcherAppDir, "main.js"),
		`const { app, dialog } = require("electron");
const { spawn } = require("node:child_process");

const launchScript = ${JSON.stringify(launchScript)};
const repoDir = ${JSON.stringify(repoDir)};

app.whenReady().then(() => {
\tconst child = spawn("/bin/bash", [launchScript], {
\t\tcwd: repoDir,
\t\tdetached: true,
\t\tstdio: "ignore",
\t\tenv: process.env,
\t});
\tchild.on("error", (error) => {
\t\tdialog.showErrorBox("mdly failed to start", error.message);
\t});
\tchild.unref();
\tapp.quit();
});
`,
	);

	signApp(outApp);
	run(
		"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
		["-f", outApp],
	);

	console.log(`[dev-app] built ${path.relative(repoDir, outApp)}`);
	console.log(`[dev-app] launch with: open "${outApp}"`);
}

await main();
