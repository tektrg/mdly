/**
 * Desktop (L0) adapter for the saved-view `ViewStore` port: the workspace's
 * `<workspace>/.hubble/views.json` (saved views R11, R13, R18, R21).
 *
 * Deliberately separate from `compareAndSwapWrite.ts` (R22: the document-save
 * helper keeps its behavior): this one also creates `.hubble/`, accepts
 * "must not exist yet", and never overwrites a corrupt file except through
 * `resetCorrupt`, which backs it up first.
 *
 * Snapshot = sha256 of the exact bytes read, so any change (another window,
 * the other Mac via sync, a hand edit) fails the compare-and-swap.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
	parseViewsFile,
	serializeViewsFile,
	type ViewStore,
	type ViewStoreReadResult,
	type ViewStoreWriteResult,
	type ViewsFile,
} from "@tektrg/table-core";

export const VIEWS_DIR_NAME = ".hubble";
export const VIEWS_FILE_NAME = "views.json";

export function viewsFilePath(workspacePath: string): string {
	return path.join(workspacePath, VIEWS_DIR_NAME, VIEWS_FILE_NAME);
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

const snapshotOf = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex");

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

type RawRead =
	| { kind: "missing" }
	| { kind: "unreadable"; error: string }
	| { kind: "bytes"; bytes: Buffer; snapshot: string };

async function readRaw(filePath: string): Promise<RawRead> {
	try {
		const bytes = await fs.readFile(filePath);
		return { kind: "bytes", bytes, snapshot: snapshotOf(bytes) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "missing" };
		}
		return { kind: "unreadable", error: message(error) };
	}
}

function classify(raw: Extract<RawRead, { kind: "bytes" }>): ViewStoreReadResult {
	let text: string;
	try {
		text = strictUtf8.decode(raw.bytes);
	} catch {
		return {
			status: "corrupt",
			reasons: ["not valid UTF-8"],
			snapshot: raw.snapshot,
		};
	}
	const parsed = parseViewsFile(text);
	return parsed.status === "ok"
		? {
				status: "ok",
				file: parsed.file,
				warnings: parsed.warnings,
				snapshot: raw.snapshot,
			}
		: { status: "corrupt", reasons: parsed.reasons, snapshot: raw.snapshot };
}

export type WorkspaceViewStoreOptions = {
	/** Test seam: runs after the temp file is written, before the rename. */
	beforeRename?: () => Promise<void>;
	/** Test seam for backup names. */
	now?: () => Date;
};

export function createWorkspaceViewStore(
	workspacePath: string,
	options: WorkspaceViewStoreOptions = {},
): Required<ViewStore> {
	const filePath = viewsFilePath(workspacePath);
	const dir = path.dirname(filePath);

	/** Temp file in the same folder + rename: a reader never sees half a file. */
	async function atomicWrite(text: string): Promise<ViewStoreWriteResult> {
		const tempPath = path.join(
			dir,
			`.${VIEWS_FILE_NAME}.${randomBytes(6).toString("hex")}.mdly-tmp`,
		);
		try {
			await fs.writeFile(tempPath, text);
			await options.beforeRename?.();
			await fs.rename(tempPath, filePath);
		} catch (error) {
			await fs.rm(tempPath, { force: true }).catch(() => {});
			return { status: "error", error: message(error) };
		}
		return { status: "ok", snapshot: snapshotOf(text) };
	}

	/** True when the file on disk is exactly what the caller last read. */
	function matches(raw: RawRead, expected: string | null): boolean {
		if (raw.kind === "missing") return expected === null;
		return raw.kind === "bytes" && raw.snapshot === expected;
	}

	return {
		async read() {
			const raw = await readRaw(filePath);
			if (raw.kind === "missing") return { status: "missing" };
			if (raw.kind === "unreadable") {
				return { status: "unreadable", error: raw.error };
			}
			return classify(raw);
		},

		async write(file: ViewsFile, expected: string | null) {
			const text = serializeViewsFile(file);
			try {
				await fs.mkdir(dir, { recursive: true });
			} catch (error) {
				return { status: "error", error: message(error) };
			}
			const before = await readRaw(filePath);
			if (before.kind === "unreadable") {
				return { status: "error", error: before.error };
			}
			if (!matches(before, expected)) return { status: "conflict" };
			// A corrupt file is only ever replaced through resetCorrupt (R18).
			if (before.kind === "bytes" && classify(before).status !== "ok") {
				return { status: "conflict" };
			}
			if (before.kind === "bytes" && before.bytes.toString("utf8") === text) {
				return { status: "ok", snapshot: before.snapshot };
			}
			// Re-check right before the rename; same window as the document CAS.
			const again = await readRaw(filePath);
			if (!matches(again, expected)) return { status: "conflict" };
			return atomicWrite(text);
		},

		async resetCorrupt(file: ViewsFile) {
			const raw = await readRaw(filePath);
			if (raw.kind === "unreadable") {
				return { status: "error", error: raw.error };
			}
			if (raw.kind === "bytes") {
				if (classify(raw).status === "ok") return { status: "conflict" };
				const stamp = (options.now?.() ?? new Date())
					.toISOString()
					.replace(/[:.]/g, "-");
				const backedUp = await backUpUniquely(raw.bytes, stamp);
				if (backedUp !== true) return backedUp;
			} else {
				try {
					await fs.mkdir(dir, { recursive: true });
				} catch (error) {
					return { status: "error", error: message(error) };
				}
			}
			return atomicWrite(serializeViewsFile(file));
		},
	};

	/** `views.json.corrupt-<ts>[-n]`, created exclusively: never overwrites a backup. */
	async function backUpUniquely(
		bytes: Buffer,
		stamp: string,
	): Promise<true | ViewStoreWriteResult> {
		for (let n = 1; n < 1000; n += 1) {
			const name = `${VIEWS_FILE_NAME}.corrupt-${stamp}${n === 1 ? "" : `-${n}`}`;
			try {
				await fs.writeFile(path.join(dir, name), bytes, { flag: "wx" });
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
				return { status: "error", error: message(error) };
			}
		}
		return { status: "error", error: "no free backup name" };
	}
}
