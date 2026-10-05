import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareAndSwapWriteFile } from "./compareAndSwapWrite";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdly-cas-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("compareAndSwapWriteFile", () => {
	it("writes when the file still matches, leaving no temp file", async () => {
		const file = path.join(dir, "a.md");
		await fs.writeFile(file, "old");
		expect(await compareAndSwapWriteFile(file, "old", "new")).toEqual({
			ok: true,
		});
		expect(await fs.readFile(file, "utf8")).toBe("new");
		expect(await fs.readdir(dir)).toEqual(["a.md"]);
	});

	it("refuses when the content changed", async () => {
		const file = path.join(dir, "a.md");
		await fs.writeFile(file, "someone else");
		expect(await compareAndSwapWriteFile(file, "old", "new")).toEqual({
			ok: false,
			reason: "changed",
		});
		expect(await fs.readFile(file, "utf8")).toBe("someone else");
	});

	it("refuses a deleted file instead of recreating it", async () => {
		const file = path.join(dir, "gone.md");
		expect(await compareAndSwapWriteFile(file, "old", "new")).toEqual({
			ok: false,
			reason: "missing",
		});
		await expect(fs.stat(file)).rejects.toThrow();
	});

	it("refuses a file that is not valid UTF-8, bytes untouched", async () => {
		const file = path.join(dir, "latin1.md");
		const bytes = Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xe9, 0x0a]);
		await fs.writeFile(file, bytes);
		const result = await compareAndSwapWriteFile(file, "---\n�\n", "x");
		expect(result).toEqual({ ok: false, reason: "not-utf8" });
		expect(Buffer.compare(await fs.readFile(file), bytes)).toBe(0);
	});

	it("re-checks right before the rename: a write during the temp write wins", async () => {
		const file = path.join(dir, "a.md");
		await fs.writeFile(file, "old");
		const result = await compareAndSwapWriteFile(file, "old", "new", () =>
			fs.writeFile(file, "agent edit"),
		);
		expect(result).toEqual({ ok: false, reason: "changed" });
		expect(await fs.readFile(file, "utf8")).toBe("agent edit");
		expect(await fs.readdir(dir)).toEqual(["a.md"]);
	});
});
