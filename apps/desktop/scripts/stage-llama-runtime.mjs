#!/usr/bin/env node
// Stages node-llama-cpp + its full runtime dependency closure (incl. the
// @node-llama-cpp/mac-arm64-metal prebuilt binary) as a plain, npm-style
// node_modules tree under .llama-runtime/, which electron-builder ships as
// extraResources -> Contents/Resources/llama/node_modules (outside app.asar).
//
// Why not electron-builder's own node_modules collection: with pnpm's symlink
// layout it shipped node-llama-cpp without ansi-escapes and with the metal
// binary as a ".moved" placeholder (2026-11-18), so the packaged app could
// never load the local model. Copying the resolved tree ourselves is exact.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readPkg(dir) {
	return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
}

/** Node-style lookup of `name` from package dir `fromDir` (follows symlinks). */
export function findPackageDir(name, fromDir) {
	let dir = fs.realpathSync(fromDir);
	for (;;) {
		const candidate = path.join(dir, "node_modules", name);
		if (fs.existsSync(path.join(candidate, "package.json")))
			return fs.realpathSync(candidate);
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * Copies `rootName` (resolved from `fromDir`) and every dependency /
 * installed optionalDependency it needs into `destNodeModules`, npm-style:
 * hoisted to the top when free, nested under the requirer on a version
 * conflict. Peer deps are not followed. Missing required deps throw;
 * missing optional deps (other platforms' binaries) are skipped.
 * Returns the list of staged "name@version" entries.
 */
export function stageRuntime(rootName, fromDir, destNodeModules) {
	fs.rmSync(destNodeModules, { recursive: true, force: true });
	fs.mkdirSync(destNodeModules, { recursive: true });
	const staged = [];
	// queue: [name, srcResolveFromDir, installedParentDir (dir of requirer, or null for root)]
	const queue = [[rootName, fromDir, null, false]];
	while (queue.length) {
		const [name, from, parentInstallDir, optional] = queue.shift();
		const src = findPackageDir(name, from);
		if (!src) {
			if (optional) continue;
			throw new Error(
				`stage-llama-runtime: cannot resolve ${name} from ${from}`,
			);
		}
		const { version } = readPkg(src);
		// Walk up from the requirer's install dir to see what Node would find.
		let target = null;
		let existing = null;
		if (parentInstallDir) {
			let dir = parentInstallDir;
			while (dir.startsWith(destNodeModules)) {
				const c = path.join(dir, "node_modules", name);
				if (fs.existsSync(path.join(c, "package.json"))) {
					existing = c;
					break;
				}
				dir = path.dirname(dir);
			}
			if (!existing) {
				const top = path.join(destNodeModules, name);
				if (fs.existsSync(path.join(top, "package.json"))) existing = top;
			}
		}
		if (existing) {
			if (readPkg(existing).version === version) continue;
			target = path.join(parentInstallDir, "node_modules", name);
		} else {
			target = path.join(destNodeModules, name);
		}
		fs.cpSync(src, target, {
			recursive: true,
			dereference: true,
			// The package's own pnpm node_modules (symlinks) are re-staged below.
			filter: (s) =>
				!path.relative(src, s).split(path.sep).includes("node_modules"),
		});
		staged.push(`${name}@${version}`);
		const pkg = readPkg(src);
		for (const dep of Object.keys(pkg.dependencies ?? {}))
			queue.push([dep, src, target, false]);
		for (const dep of Object.keys(pkg.optionalDependencies ?? {}))
			queue.push([dep, src, target, true]);
	}
	return staged.sort();
}

function main() {
	const desktopDir = path.resolve(
		fileURLToPath(new URL("..", import.meta.url)),
	);
	const dest = path.join(desktopDir, ".llama-runtime", "node_modules");
	const staged = stageRuntime("node-llama-cpp", desktopDir, dest);
	const metal = path.join(dest, "@node-llama-cpp", "mac-arm64-metal", "bins");
	if (process.platform === "darwin" && !fs.existsSync(metal)) {
		console.error(`[stage-llama-runtime] FAIL: ${metal} missing`);
		process.exit(1);
	}
	console.log(
		`[stage-llama-runtime] staged ${staged.length} packages into ${dest}`,
	);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main();
