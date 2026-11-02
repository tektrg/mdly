#!/usr/bin/env node
// Build-time guard: the packaged app's main/preload bundles must not require()
// packages that the packaged app cannot resolve. electron-builder ships out/**
// plus a best-effort node_modules copy whose pnpm layout and "exports"
// conditions have already bitten us (@tektrg/table-core: ERR_PACKAGE_PATH_NOT_EXPORTED
// on launch). So every bare specifier must be bundled, except the runtime-provided
// ones below. Run after `electron-vite build`; exits non-zero on a violation.
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Runtime-provided modules allowed to stay external. electron-updater is
 * verified present in the packed app.asar node_modules and is only lazily
 * imported (auto-update is disabled). */
export const ALLOWED_PACKAGES = new Set(["electron", "electron-updater"]);

const BUILTINS = new Set(builtinModules);

// require("x") / import("x") only: main and preload are emitted as CJS, so
// static `import ... from` cannot execute there (and matching it hits JSDoc
// examples). A match directly preceded by a quote or backtick is
// code-inside-a-string (e.g. ajv's codegen template
// `require("ajv/dist/runtime/equal")`) and never executes.
const SPECIFIER_RE =
	/(["'`]?)\b(?:require|import)\s*\(\s*(["'])([@a-zA-Z0-9][\w@./:+-]*)\2\s*\)/g;

/** Returns the unique bare (non-relative, non-absolute) specifiers in `code`. */
export function findBareSpecifiers(code) {
	const found = new Set();
	for (const m of code.matchAll(SPECIFIER_RE)) {
		if (m[1]) continue;
		const spec = m[3];
		if (!spec || spec.startsWith(".") || spec.startsWith("/")) continue;
		found.add(spec);
	}
	return [...found];
}

/** Package name of a specifier: "@a/b/c" -> "@a/b", "x/y" -> "x". */
export function packageName(spec) {
	const parts = spec.split("/");
	return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function isAllowed(spec) {
	if (spec.startsWith("node:")) return true;
	if (BUILTINS.has(spec)) return true;
	return ALLOWED_PACKAGES.has(packageName(spec));
}

/** Disallowed specifiers in `code`. */
export function findViolations(code) {
	return findBareSpecifiers(code).filter((s) => !isAllowed(s));
}

function main() {
	const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
	const problems = [];
	for (const dir of ["out/main", "out/preload"]) {
		let files;
		try {
			files = readdirSync(join(root, dir)).filter((f) => /\.[cm]?js$/.test(f));
		} catch {
			problems.push(`${dir}: missing — run electron-vite build first`);
			continue;
		}
		for (const f of files) {
			for (const spec of findViolations(
				readFileSync(join(root, dir, f), "utf8"),
			)) {
				problems.push(`${dir}/${f}: require("${spec}")`);
			}
		}
	}
	if (problems.length) {
		console.error(
			"[check-bundled-deps] FAIL: main/preload bundles reference packages the packaged app may not resolve:",
		);
		for (const p of problems) console.error(`  - ${p}`);
		console.error(
			'Fix: add the package (and any subpath, e.g. "pkg/sub") to externalizeDepsPlugin({ exclude: [...] }) in apps/desktop/electron.vite.config.ts so it is bundled, or — only if it is truly runtime-provided — to ALLOWED_PACKAGES in apps/desktop/scripts/check-bundled-deps.mjs.',
		);
		process.exit(1);
	}
	console.log(
		"[check-bundled-deps] OK: out/main and out/preload are self-contained",
	);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main();
