import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type CompareAndSwapResult =
	| { ok: true }
	| { ok: false; reason: "missing" | "changed" | "not-utf8" };

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Writes `next` only if the file still holds exactly `expected` (strict UTF-8),
 * via a temp file in the same folder + rename, so a reader never sees a half
 * write and a concurrent writer's bytes are never silently overwritten between
 * the check and the write. Refuses (never recreates) a file that is gone.
 * The window left is the check→rename gap (microseconds, same process).
 */
export async function compareAndSwapWriteFile(
	filePath: string,
	expected: string,
	next: string,
	/** Test seam: runs after the temp file is written, before the re-check. */
	beforeRename?: () => Promise<void>,
): Promise<CompareAndSwapResult> {
	const first = await readStrict(filePath);
	if (typeof first !== "string") return first;
	if (first !== expected) return { ok: false, reason: "changed" };

	const stat = await fs.stat(filePath);
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.mdly-tmp`,
	);
	try {
		await fs.writeFile(tempPath, next, { mode: stat.mode & 0o777 });
		await beforeRename?.();
		// Re-check right before the rename: the temp write took real time.
		const again = await readStrict(filePath);
		if (typeof again !== "string") {
			await fs.rm(tempPath, { force: true });
			return again;
		}
		if (again !== expected) {
			await fs.rm(tempPath, { force: true });
			return { ok: false, reason: "changed" };
		}
		await fs.rename(tempPath, filePath);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw error;
	}
	return { ok: true };
}

async function readStrict(
	filePath: string,
): Promise<string | Exclude<CompareAndSwapResult, { ok: true }>> {
	let bytes: Buffer;
	try {
		bytes = await fs.readFile(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { ok: false, reason: "missing" };
		}
		throw error;
	}
	try {
		return strictUtf8.decode(bytes);
	} catch {
		return { ok: false, reason: "not-utf8" };
	}
}
