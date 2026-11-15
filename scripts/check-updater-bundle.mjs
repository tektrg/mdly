#!/usr/bin/env node
// Verifies, on a PACKAGED app.asar, the two facts the in-app updater depends on:
//   1. the update stamp (package.json "mdlyAutoUpdate") is present for a release build and
//      absent for every other build (see apps/desktop/electron/updateGate.ts);
//   2. when stamped, electron-updater and its full runtime dependency tree can be resolved
//      from inside the archive (node_modules), plus app-update.yml sits next to it with the
//      GitHub feed. A missing piece would only surface as a runtime error on a user's Mac.
// Usage: node check-updater-bundle.mjs <path/to/app.asar> <on|off>
// Exit 0 = OK, 1 = mismatch, 2 = usage.
import fs from "node:fs";
import path from "node:path";

const [asarPath, expectArg] = process.argv.slice(2);
if (!asarPath || !["on", "off"].includes(expectArg)) {
	console.error("usage: check-updater-bundle.mjs <app.asar> <on|off>");
	process.exit(2);
}
const expectOn = expectArg === "on";
const fail = (msg) => {
	console.error(`[updater-check] FAILED ${asarPath}: ${msg}`);
	process.exit(1);
};

const fd = fs.openSync(asarPath, "r");
const read = (pos, len) => {
	const b = Buffer.alloc(len);
	fs.readSync(fd, b, 0, len, pos);
	return b;
};
const headerSize = read(0, 8).readUInt32LE(4);
const hdr = read(8, headerSize);
const header = JSON.parse(
	hdr.subarray(8, 8 + hdr.readUInt32LE(4)).toString("utf8"),
);
const base = 8 + headerSize;
const lookup = (p) => {
	let node = header;
	for (const part of p.split("/").filter(Boolean)) {
		node = node?.files?.[part];
		if (!node) return null;
	}
	return node;
};
const readJson = (p) => {
	const node = lookup(p);
	if (!node || node.files) return null;
	if (node.unpacked) {
		return JSON.parse(
			fs.readFileSync(
				path.join(`${asarPath}.unpacked`, p.replace(/^\//, "")),
				"utf8",
			),
		);
	}
	return JSON.parse(
		read(base + Number(node.offset), node.size).toString("utf8"),
	);
};

const pkg = readJson("package.json");
if (!pkg) fail("no package.json in archive");
const stamp = pkg.mdlyAutoUpdate;
if (expectOn && stamp !== "developer-id") {
	fail(`expected the update stamp, found ${JSON.stringify(stamp)}`);
}
if (!expectOn && stamp !== undefined) {
	fail(`this build must NOT be update-stamped, found ${JSON.stringify(stamp)}`);
}
if (!expectOn) {
	console.log("[updater-check] OK: no update stamp (updates stay off)");
	process.exit(0);
}

// Resolve electron-updater's runtime dependency tree the way Node would from the app root.
const seen = new Set();
const missing = [];
const resolveDir = (fromDir, name) => {
	for (let dir = fromDir; ; dir = path.posix.dirname(dir)) {
		const cand = path.posix.join(dir, "node_modules", name);
		if (lookup(`${cand}/package.json`)) return cand;
		if (dir === "/" || dir === ".") return null;
	}
};
const visit = (dir) => {
	if (seen.has(dir)) return;
	seen.add(dir);
	const meta = readJson(`${dir}/package.json`);
	for (const dep of Object.keys(meta?.dependencies ?? {})) {
		const found = resolveDir(dir, dep);
		if (!found) missing.push(`${dep} (needed by ${meta.name})`);
		else visit(found);
	}
};
const updaterDir = "/node_modules/electron-updater";
const updaterMeta = readJson(`${updaterDir}/package.json`);
if (!updaterMeta) fail("electron-updater is not inside app.asar/node_modules");
const entry = (updaterMeta.main ?? "index.js").replace(/^\.\//, "");
if (!lookup(`${updaterDir}/${entry}`))
	fail(`electron-updater entry ${entry} missing`);
visit(updaterDir);
if (missing.length) fail(`unresolvable dependencies: ${missing.join(", ")}`);

const updateYml = path.join(path.dirname(asarPath), "app-update.yml");
let feed = "";
try {
	feed = fs.readFileSync(updateYml, "utf8");
} catch {
	fail("app-update.yml (the feed config) is missing next to app.asar");
}
if (!/provider:\s*github/.test(feed) || !/repo:\s*mdly/.test(feed)) {
	fail("app-update.yml does not point at the GitHub mdly feed");
}
if (!/releaseType:\s*release\b/.test(feed) || /channel:/.test(feed)) {
	fail("app-update.yml must be releaseType release on the default channel");
}
console.log(
	`[updater-check] OK: stamp present, electron-updater@${updaterMeta.version} + ${seen.size - 1} dependencies resolvable in the asar, feed = github tektrg/mdly (releaseType release)`,
);
