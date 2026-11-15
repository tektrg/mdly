import fs from "node:fs";
import path from "node:path";

/**
 * In-app auto-update is OFF unless the build says otherwise.
 *
 * Squirrel.Mac (what electron-updater drives on macOS) refuses to apply an
 * update to an app that is not code-signed, and the Mac App Store edition is
 * updated by the store. So the only build that may self-update is the
 * Developer-ID signed DMG. `scripts/release-dmg.sh` stamps that build by
 * writing `mdlyAutoUpdate: "developer-id"` into the packaged package.json
 * (electron-builder `extraMetadata`, see `scripts/install-prod-app.sh`). Every
 * other build (dev, the daily unsigned prod install, a future MAS build) lacks
 * the stamp and stays update-free. The stamp is a build-time fact, so it cannot
 * be flipped on by an env var or a setting at runtime.
 */
export const AUTO_UPDATE_MARKER_KEY = "mdlyAutoUpdate";
export const AUTO_UPDATE_MARKER_VALUE = "developer-id";

export type UpdateGateInput = {
	/** `app.isPackaged`, already false when dev mode is forced. */
	isPackaged: boolean;
	/** `process.mas === true`: the Mac App Store build. */
	isMas: boolean;
	/** Parsed package.json of the running app (null when unreadable). */
	packageMetadata: unknown;
};

export type UpdateGate =
	| { supported: true; message: null }
	| { supported: false; message: string };

export const UPDATES_DISABLED_DEV_MESSAGE =
	"Automatic updates are disabled in development builds.";
export const UPDATES_DISABLED_MAS_MESSAGE =
	"Updates for this edition are delivered through the Mac App Store.";
export const UPDATES_DISABLED_UNSIGNED_MESSAGE =
	"Automatic updates are disabled for this build. They are only available in the signed mdly release downloaded from GitHub.";

export function resolveUpdateGate(input: UpdateGateInput): UpdateGate {
	if (!input.isPackaged) {
		return { supported: false, message: UPDATES_DISABLED_DEV_MESSAGE };
	}
	if (input.isMas) {
		return { supported: false, message: UPDATES_DISABLED_MAS_MESSAGE };
	}
	const meta = input.packageMetadata;
	const stamped =
		typeof meta === "object" &&
		meta !== null &&
		(meta as Record<string, unknown>)[AUTO_UPDATE_MARKER_KEY] ===
			AUTO_UPDATE_MARKER_VALUE;
	if (!stamped) {
		return { supported: false, message: UPDATES_DISABLED_UNSIGNED_MESSAGE };
	}
	return { supported: true, message: null };
}

/** Reads `<appPath>/package.json` (inside app.asar when packaged); null on any failure. */
export function readPackageMetadata(
	appPath: string,
	readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): unknown {
	try {
		return JSON.parse(readFile(path.join(appPath, "package.json")));
	} catch {
		return null;
	}
}
