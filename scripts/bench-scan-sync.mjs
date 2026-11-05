#!/usr/bin/env node
// Benchmark workspace discovery + the sync local-snapshot path (read + hash).
// Usage: pnpm bench:scan-sync [--sizes 1000,10000,40000] [--runs 5] [realFolder]
// Requires built dist of @mdly/workspace-scan and @hubble.md/sync.
// Synthetic workspaces live under $TMPDIR/mdly-bench-<n> and are reused.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { discoverWorkspaceFiles } = await import(
	path.join(root, "packages/workspace-scan/dist/index.js")
);
const { createNodeFileSystem } = await import(
	path.join(root, "packages/sync/dist/fs-node.js")
);

const args = process.argv.slice(2);
let sizes = [1000, 10000, 40000];
let runs = 5;
const real = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--sizes") sizes = args[++i].split(",").map(Number);
	else if (args[i] === "--runs") runs = Number(args[++i]);
	else real.push(path.resolve(args[i]));
}

function generate(count) {
	const dir = path.join(tmpdir(), `mdly-bench-${count}`);
	const marker = path.join(dir, ".bench-complete");
	if (existsSync(marker)) return dir;
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, ".gitignore"), "ignored/\n*.tmp\n");
	const perDir = 25;
	const dirs = Math.ceil(count / perDir);
	for (let d = 0; d < dirs; d++) {
		// 3-level nesting: a/b/c
		const rel = path.join(
			`area-${d % 8}`,
			`topic-${Math.floor(d / 8) % 20}`,
			`d${d}`,
		);
		const abs = path.join(dir, rel);
		mkdirSync(abs, { recursive: true });
		if (d % 10 === 0)
			writeFileSync(path.join(abs, ".gitignore"), "drafts/\n!keep.md\n");
		for (let f = 0; f < perDir && d * perDir + f < count; f++) {
			const body = `# Note ${d}-${f}\n\n${"Lorem ipsum dolor sit amet. ".repeat(20 + (f % 30))}\n`;
			writeFileSync(path.join(abs, `note-${f}.md`), body);
		}
		if (d % 5 === 0) {
			mkdirSync(path.join(abs, "note-0.assets"), { recursive: true });
			writeFileSync(
				path.join(abs, "note-0.assets", "img.png"),
				Buffer.alloc(4096, d % 251),
			);
		}
		if (d % 20 === 0) {
			mkdirSync(path.join(abs, "ignored"), { recursive: true });
			writeFileSync(path.join(abs, "ignored", "x.md"), "ignored");
		}
	}
	const nm = path.join(dir, "node_modules", "pkg");
	mkdirSync(nm, { recursive: true });
	for (let i = 0; i < 200; i++) writeFileSync(path.join(nm, `f${i}.md`), "x");
	writeFileSync(marker, "");
	return dir;
}

async function median(fn) {
	const times = [];
	let last;
	for (let i = 0; i < runs; i++) {
		const t = performance.now();
		last = await fn();
		times.push(performance.now() - t);
	}
	times.sort((a, b) => a - b);
	return { ms: times[Math.floor(times.length / 2)], last };
}

const targets = [
	...sizes.map((n) => ({ label: `synthetic ${n}`, dir: generate(n) })),
	...real.map((dir) => ({ label: dir, dir })),
];
const rows = [];
for (const { label, dir } of targets) {
	const scan = await median(() =>
		discoverWorkspaceFiles({
			workspaceRoot: dir,
			isSupportedFile: (p) => p.endsWith(".md"),
		}),
	);
	const fsys = createNodeFileSystem();
	const sync = await median(async () => {
		const [notes, assets, sidecars] = await Promise.all([
			fsys.listMarkdownFiles(dir),
			fsys.listAssetFiles(dir),
			fsys.listSidecarFiles(dir),
		]);
		return notes.length + assets.length + sidecars.length;
	});
	rows.push({
		target: label,
		files: scan.last.files.length,
		"scan ms": scan.ms.toFixed(1),
		"sync snapshot ms": sync.ms.toFixed(1),
		"sync items": sync.last,
	});
}
console.table(rows);
