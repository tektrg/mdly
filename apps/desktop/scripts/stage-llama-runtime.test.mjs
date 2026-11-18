import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageRuntime } from "./stage-llama-runtime.mjs";

let tmp;
afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

/** pnpm-like store: .pnpm/<id>/node_modules/<name> + symlinked deps. */
function pkg(store, name, version, deps = {}, optional = {}) {
	const dir = path.join(
		store,
		`${name.replace("/", "+")}@${version}`,
		"node_modules",
		name,
	);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({
			name,
			version,
			dependencies: deps,
			optionalDependencies: optional,
		}),
	);
	fs.writeFileSync(
		path.join(dir, "index.js"),
		`module.exports = "${name}@${version}";`,
	);
	return dir;
}
function link(fromPkgDir, name, toPkgDir) {
	const l = path.join(path.dirname(fromPkgDir).replace(/\/@[^/]+$/, ""), name);
	if (fs.existsSync(l)) return;
	fs.mkdirSync(path.dirname(l), { recursive: true });
	fs.symlinkSync(toPkgDir, l);
}

describe("stageRuntime", () => {
	it("copies the full closure out of a symlinked pnpm layout, nesting version conflicts and skipping absent optional deps", () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stage-llama-"));
		const store = path.join(tmp, "node_modules", ".pnpm");
		const root = pkg(
			store,
			"llama",
			"1.0.0",
			{ esc: "1", mid: "1" },
			{ "@bin/mac": "1", "@bin/win": "1" },
		);
		const esc1 = pkg(store, "esc", "1.0.0");
		const esc2 = pkg(store, "esc", "2.0.0");
		const mid = pkg(store, "mid", "1.0.0", { esc: "2" });
		const bin = pkg(store, "@bin/mac", "1.0.0");
		link(root, "esc", esc1);
		link(root, "mid", mid);
		link(root, "@bin/mac", bin);
		link(mid, "esc", esc2);
		const app = path.join(tmp, "app");
		fs.mkdirSync(app);
		fs.symlinkSync(root, path.join(tmp, "node_modules", "llama"));

		const dest = path.join(tmp, "out", "node_modules");
		const staged = stageRuntime("llama", app, dest);

		expect(staged).toEqual([
			"@bin/mac@1.0.0",
			"esc@1.0.0",
			"esc@2.0.0",
			"llama@1.0.0",
			"mid@1.0.0",
		]);
		const fromRoot = createRequire(path.join(dest, "llama", "index.js"));
		expect(fromRoot("esc")).toBe("esc@1.0.0");
		expect(fromRoot("@bin/mac")).toBe("@bin/mac@1.0.0");
		const fromMid = createRequire(path.join(dest, "mid", "index.js"));
		expect(fromMid("esc")).toBe("esc@2.0.0");
		expect(fs.lstatSync(path.join(dest, "llama")).isSymbolicLink()).toBe(false);
	});

	it("fails loudly when a required dependency cannot be resolved", () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stage-llama-"));
		const store = path.join(tmp, "node_modules", ".pnpm");
		const root = pkg(store, "llama", "1.0.0", { "ansi-escapes": "1" });
		fs.symlinkSync(root, path.join(tmp, "node_modules", "llama"));
		expect(() => stageRuntime("llama", tmp, path.join(tmp, "out"))).toThrow(
			/ansi-escapes/,
		);
	});
});
