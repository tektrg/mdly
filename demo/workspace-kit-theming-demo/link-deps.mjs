// Populates this demo's own node_modules by symlinking straight to the exact
// package versions the mdly monorepo's pnpm install already resolved for
// packages/workspace-kit (its own node_modules/<pkg> entries, which pnpm
// keeps as symlinks into its content-addressable store). This demo is
// deliberately NOT a pnpm-workspace.yaml member (see package.json's
// description and the repo root's pnpm-workspace.yaml globs), so a plain
// `npm install`/`pnpm install` here would independently re-resolve every
// dependency's peer/version graph against the live registry -- which drifts
// over time and can produce a different (or ERESOLVE-conflicting) tree than
// what @mdly/workspace-kit was actually built and tested against. Symlinking
// straight to the monorepo's already-resolved copies guarantees this demo
// always runs the exact same dependency versions as the kit it's proving,
// with no network access and no independent resolution step at all.
//
// Run this once after `pnpm install` at the repo root (or whenever the kit's
// own dependencies change), then `npm run build` / `npm run serve` as usual.
import { existsSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const demoDir = fileURLToPath(new URL(".", import.meta.url));
const kitNodeModules = join(demoDir, "../../packages/workspace-kit/node_modules");
const kitPackageDir = join(demoDir, "../../packages/workspace-kit");
const demoNodeModules = join(demoDir, "node_modules");
const repoRootPnpmStore = join(demoDir, "../../node_modules/.pnpm");

// Every bare-specifier import this demo's own source, and the kit's prebuilt
// dist/index.js (which externalizes all of these -- see
// packages/workspace-kit/vite.config.ts's `isExternal`), needs resolvable at
// bundle time.
const packages = [
	"react",
	"react-dom",
	"@base-ui/react",
	"@dnd-kit/core",
	"@floating-ui/dom",
	"@tiptap/core",
	"@tiptap/pm",
	"@tiptap/react",
	"@tiptap/starter-kit",
	"@tiptap/extension-code-block-lowlight",
	"@tiptap/extension-list",
	"mermaid",
	"lowlight",
	"highlight.js",
	"cmdk",
	"keymatch",
	"hast-util-from-html",
	"remark-gfm",
	"remark-parse",
	"unified",
	"unist-util-visit",
	"yaml",
	"zod",
	"tailwind-merge",
	"clsx",
	"class-variance-authority",
];

function linkOne(name, targetDir) {
	const linkPath = join(demoNodeModules, name);
	mkdirSync(dirname(linkPath), { recursive: true });
	if (existsSync(linkPath) || isBrokenSymlink(linkPath)) {
		unlinkSync(linkPath);
	}
	symlinkSync(targetDir, linkPath, "dir");
	console.log(`linked ${name} -> ${targetDir}`);
}

function isBrokenSymlink(path) {
	try {
		readlinkSync(path);
		return !existsSync(path);
	} catch {
		return false;
	}
}

mkdirSync(demoNodeModules, { recursive: true });

// @mdly/workspace-kit itself -- the package under test, linked straight to
// its real source directory (dist/ + package.json), not copied.
linkOne("@mdly/workspace-kit", kitPackageDir);

for (const name of packages) {
	const target = join(kitNodeModules, name);
	if (!existsSync(target)) {
		console.warn(
			`WARNING: ${target} not found -- run "pnpm install" at the repo root first.`,
		);
		continue;
	}
	linkOne(name, target);
}

// @types/react and @types/react-dom (dev-only, for editor/tsc support) --
// same treatment, purely for IDE type-checking, not needed by esbuild itself.
for (const name of ["@types/react", "@types/react-dom"]) {
	const target = join(kitNodeModules, name);
	if (existsSync(target)) linkOne(name, target);
}

// This demo's own build tooling (esbuild, typescript) -- typescript already
// sits in the kit's own node_modules; esbuild is only a transitive dep of
// the kit's `vite`, so it's pulled straight from the repo root's pnpm store
// instead (any recent version works -- this demo only uses esbuild's plain
// bundling API, nothing version-sensitive).
const typescriptTarget = join(kitNodeModules, "typescript");
if (existsSync(typescriptTarget)) linkOne("typescript", typescriptTarget);

if (existsSync(repoRootPnpmStore)) {
	const esbuildStoreDir = readdirSync(repoRootPnpmStore)
		.filter((entry) => entry.startsWith("esbuild@"))
		.sort()
		.at(-1);
	if (esbuildStoreDir) {
		linkOne(
			"esbuild",
			join(repoRootPnpmStore, esbuildStoreDir, "node_modules/esbuild"),
		);
	} else {
		console.warn("WARNING: no esbuild found in the repo root's pnpm store.");
	}
}

console.log("Done. Run `npm run build` (or `npm run serve`) next.");
