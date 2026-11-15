import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	AUTO_UPDATE_MARKER_KEY,
	AUTO_UPDATE_MARKER_VALUE,
	readPackageMetadata,
	resolveUpdateGate,
	UPDATES_DISABLED_DEV_MESSAGE,
	UPDATES_DISABLED_MAS_MESSAGE,
	UPDATES_DISABLED_UNSIGNED_MESSAGE,
} from "./updateGate";

const stamped = { [AUTO_UPDATE_MARKER_KEY]: AUTO_UPDATE_MARKER_VALUE };

describe("resolveUpdateGate", () => {
	it("is on only for a packaged, stamped, non-MAS build", () => {
		expect(
			resolveUpdateGate({
				isPackaged: true,
				isMas: false,
				packageMetadata: stamped,
			}),
		).toEqual({ supported: true, message: null });
	});

	it("is off for the daily unsigned prod install (packaged, no stamp)", () => {
		const gate = resolveUpdateGate({
			isPackaged: true,
			isMas: false,
			packageMetadata: { name: "@hubble.md/desktop", version: "0.1.14" },
		});
		expect(gate).toEqual({
			supported: false,
			message: UPDATES_DISABLED_UNSIGNED_MESSAGE,
		});
	});

	it("is off in dev even when the stamp is present", () => {
		expect(
			resolveUpdateGate({
				isPackaged: false,
				isMas: false,
				packageMetadata: stamped,
			}),
		).toEqual({ supported: false, message: UPDATES_DISABLED_DEV_MESSAGE });
	});

	it("is off for the Mac App Store build even when the stamp is present", () => {
		expect(
			resolveUpdateGate({
				isPackaged: true,
				isMas: true,
				packageMetadata: stamped,
			}),
		).toEqual({ supported: false, message: UPDATES_DISABLED_MAS_MESSAGE });
	});

	it.each([
		["missing metadata", null],
		["non-object metadata", "developer-id"],
		["wrong value", { [AUTO_UPDATE_MARKER_KEY]: true }],
		["empty value", { [AUTO_UPDATE_MARKER_KEY]: "" }],
		["another value", { [AUTO_UPDATE_MARKER_KEY]: "mas" }],
	])("stays off for a packaged build with %s", (_label, packageMetadata) => {
		expect(
			resolveUpdateGate({ isPackaged: true, isMas: false, packageMetadata })
				.supported,
		).toBe(false);
	});

	it("every disabled gate carries a message for the Settings screen", () => {
		for (const input of [
			{ isPackaged: false, isMas: false, packageMetadata: stamped },
			{ isPackaged: true, isMas: true, packageMetadata: stamped },
			{ isPackaged: true, isMas: false, packageMetadata: {} },
		]) {
			const gate = resolveUpdateGate(input);
			expect(gate.supported).toBe(false);
			expect(gate.message).toBeTruthy();
		}
	});
});

describe("readPackageMetadata", () => {
	it("parses <appPath>/package.json", () => {
		let requested = "";
		const meta = readPackageMetadata("/inert/app", (file) => {
			requested = file;
			return JSON.stringify(stamped);
		});
		expect(requested).toBe("/inert/app/package.json");
		expect(meta).toEqual(stamped);
	});

	it("returns null when the file is unreadable or not JSON", () => {
		expect(
			readPackageMetadata("/inert/app", () => {
				throw new Error("ENOENT");
			}),
		).toBeNull();
		expect(readPackageMetadata("/inert/app", () => "{not json")).toBeNull();
	});
});

describe("committed build config", () => {
	const pkg = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);

	it("does not carry the update stamp (default is off; only release-dmg.sh stamps)", () => {
		expect(pkg[AUTO_UPDATE_MARKER_KEY]).toBeUndefined();
		expect(pkg.build.extraMetadata?.[AUTO_UPDATE_MARKER_KEY]).toBeUndefined();
	});

	it("feeds updates from normal tektrg/mdly GitHub releases only", () => {
		expect(pkg.build.publish).toEqual([
			{
				provider: "github",
				owner: "tektrg",
				repo: "mdly",
				tagNamePrefix: "desktop-v",
				releaseType: "release",
			},
		]);
	});

	it("ships electron-updater as a production dependency", () => {
		expect(pkg.dependencies["electron-updater"]).toBeDefined();
		expect(pkg.devDependencies["electron-updater"]).toBeUndefined();
	});
});
