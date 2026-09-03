import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

/**
 * Shared bearer-credential store (R20): the desktop app and the CLI both
 * authenticate with one bearer token — currently the shared Cloud Sync
 * password itself (R38, see `apps/www/worker/auth.ts`'s comment on this) —
 * and that token must live ONLY in the macOS Keychain, never in
 * `.hubble/config.json`, never baked into a built JS bundle. Both runtimes
 * shell out to the same `/usr/bin/security` binary rather than depend on a
 * native Node module, so this file has zero native-addon build step and
 * behaves identically from Electron's main process and a plain `node` CLI
 * process — the whole reason it lives in this Node-only subpath
 * (`@mdly/cloudflare-client/keychain`) rather than the package's root entry,
 * which apps/www's browser bundle also imports and must never need to
 * resolve `node:child_process` for.
 */
export interface KeychainCredentialStore {
	getPassword(account: string): Promise<string | null>;
	setPassword(account: string, secret: string): Promise<void>;
	deletePassword(account: string): Promise<void>;
}

export type ExecFile = (
	file: string,
	args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export type CreateMacKeychainCredentialStoreOptions = {
	/** Keychain "service" field distinguishing mdly's entries from anything else in the user's Keychain. */
	service?: string;
	/** Injected for tests; defaults to shelling out to the real `/usr/bin/security`. */
	execFile?: ExecFile;
	/** Injected for tests; defaults to the real binary path. */
	securityBinPath?: string;
};

const DEFAULT_SERVICE = "mdly-cloud-sync";
const DEFAULT_SECURITY_BIN = "/usr/bin/security";

/** The `security(1)` exit code for "the specified item could not be found in the keychain." */
const ITEM_NOT_FOUND_EXIT_CODE = 44;

const defaultExecFile: ExecFile = promisify(execFileCb) as unknown as ExecFile;

/**
 * The one Keychain account name every mdly cloud-sync credential is stored
 * under. There is exactly one shared password for every opted-in workspace
 * (R38, D8d) — not a per-workspace or per-device entry — so every caller
 * (desktop, CLI) reads/writes this same account.
 */
export const SHARED_CLOUD_SYNC_ACCOUNT = "mdly-cloud-sync-password";

/**
 * A Keychain-backed `KeychainCredentialStore` for macOS, via `security(1)`.
 * `setPassword` always passes `-U` so re-entering a rotated password updates
 * the existing item in place instead of erroring on a duplicate.
 */
export function createMacKeychainCredentialStore(
	options: CreateMacKeychainCredentialStoreOptions = {},
): KeychainCredentialStore {
	const service = options.service ?? DEFAULT_SERVICE;
	const securityBin = options.securityBinPath ?? DEFAULT_SECURITY_BIN;
	const run = options.execFile ?? defaultExecFile;

	return {
		async getPassword(account) {
			try {
				const { stdout } = await run(securityBin, [
					"find-generic-password",
					"-a",
					account,
					"-s",
					service,
					"-w",
				]);
				const value = stdout.replace(/\r?\n+$/, "");
				return value.length > 0 ? value : null;
			} catch (error) {
				if (isExitCode(error, ITEM_NOT_FOUND_EXIT_CODE)) return null;
				throw error;
			}
		},

		async setPassword(account, secret) {
			await run(securityBin, [
				"add-generic-password",
				"-a",
				account,
				"-s",
				service,
				"-w",
				secret,
				"-U",
			]);
		},

		async deletePassword(account) {
			try {
				await run(securityBin, [
					"delete-generic-password",
					"-a",
					account,
					"-s",
					service,
				]);
			} catch (error) {
				if (isExitCode(error, ITEM_NOT_FOUND_EXIT_CODE)) return;
				throw error;
			}
		},
	};
}

function isExitCode(error: unknown, code: number): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}
