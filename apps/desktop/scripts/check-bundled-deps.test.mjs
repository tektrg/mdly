import { describe, expect, it } from "vitest";
import {
	findBareSpecifiers,
	findViolations,
	packageName,
} from "./check-bundled-deps.mjs";

describe("check-bundled-deps scanner", () => {
	it("allows node built-ins, node: prefix, electron and electron-updater", () => {
		const code = `const a = require("fs"); const b = require("node:path");
const c = require("fs/promises"); const e = require("electron");
const u = await import("electron-updater");`;
		expect(findViolations(code)).toEqual([]);
	});

	it("flags externalized packages including scoped subpaths", () => {
		const code = `const t = require("@tektrg/table-core");
const k = require('@mdly/cloudflare-client/keychain');
const z = require("zod"); const p = await import("lazy-pkg");
// static ESM syntax never runs in the CJS bundle (JSDoc examples):
// import { unified } from 'unified'`;
		expect(findViolations(code).sort()).toEqual(
			[
				"@mdly/cloudflare-client/keychain",
				"@tektrg/table-core",
				"lazy-pkg",
				"zod",
			].sort(),
		);
	});

	it("ignores relative paths and requires embedded in strings", () => {
		const code = `require("./chunk.js"); require("../x");
x.code = 'require("ajv/dist/runtime/uri").default';
y = _\`require("ajv-formats/dist/formats")\`;`;
		expect(findBareSpecifiers(code)).toEqual([]);
	});

	it("derives package names", () => {
		expect(packageName("@a/b/c.js")).toBe("@a/b");
		expect(packageName("electron-updater/out")).toBe("electron-updater");
	});
});
