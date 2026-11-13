#!/usr/bin/env node
// Structural + content integrity check of a packaged app.asar, no dependencies.
// Usage: node check-app-asar.mjs <path/to/app.asar>
// Fails (exit 1) when: the header is unreadable, any packed file lies outside
// the archive, any file's electron-builder integrity hash mismatches, the packed
// package.json is unreadable, or its "main" entry is missing from the archive.
// Catches a release dir rewritten mid-pack (2026-11-13: two concurrent ships).
import { createHash } from "node:crypto";
import fs from "node:fs";

const asarPath = process.argv[2];
if (!asarPath) {
	console.error("usage: check-app-asar.mjs <app.asar>");
	process.exit(2);
}
const fail = (msg) => {
	console.error(`[asar-check] FAILED ${asarPath}: ${msg}`);
	process.exit(1);
};

let fd;
try {
	fd = fs.openSync(asarPath, "r");
} catch (e) {
	fail(`cannot open (${e.message})`);
}
const fileSize = fs.fstatSync(fd).size;
const read = (pos, len) => {
	const b = Buffer.alloc(len);
	if (fs.readSync(fd, b, 0, len, pos) !== len) fail(`short read at ${pos}+${len}`);
	return b;
};
if (fileSize < 16) fail("file too small");
// Pickle layout: [u32 4][u32 headerPickleSize] [u32 payload][u32 strLen][json]
const headerSize = read(0, 8).readUInt32LE(4);
if (headerSize <= 0 || 8 + headerSize > fileSize) fail("header size out of range");
const hdr = read(8, headerSize);
const strLen = hdr.readUInt32LE(4);
let header;
try {
	header = JSON.parse(hdr.subarray(8, 8 + strLen).toString("utf8"));
} catch (e) {
	fail(`header JSON unreadable (${e.message})`);
}
const base = 8 + headerSize;

let files = 0;
let hashed = 0;
const lookup = (p) => {
	let node = header;
	for (const part of p.split("/").filter(Boolean)) {
		node = node?.files?.[part];
		if (!node) return null;
	}
	return node;
};
const readEntry = (node) => read(base + Number(node.offset), node.size);
const walk = (node, prefix) => {
	for (const [name, child] of Object.entries(node.files ?? {})) {
		const p = `${prefix}/${name}`;
		if (child.files) walk(child, p);
		else if (child.link || child.unpacked) continue;
		else {
			files++;
			const end = base + Number(child.offset) + child.size;
			if (end > fileSize) fail(`${p} extends past end of archive`);
			if (child.integrity?.hash) {
				const h = createHash("sha256").update(readEntry(child)).digest("hex");
				if (h !== child.integrity.hash) fail(`${p} integrity hash mismatch`);
				hashed++;
			}
		}
	}
};
walk(header, "");

const pkgNode = lookup("package.json");
if (!pkgNode) fail("no package.json in archive");
let pkg;
try {
	pkg = JSON.parse(readEntry(pkgNode).toString("utf8"));
} catch (e) {
	fail(`packed package.json unreadable (${e.message})`);
}
const main = (pkg.main ?? "index.js").replace(/^\.\//, "");
const mainNode = lookup(main);
if (!mainNode || mainNode.size === 0) fail(`main entry ${main} missing/empty`);
console.log(
	`[asar-check] OK ${asarPath}: ${files} files (${hashed} hash-verified), main=${main}`,
);
