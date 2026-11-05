import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	discoverWorkspaceFiles,
	WorkspaceTraversalLimitError,
} from "./file-discovery";

// A limit hit early in a huge flat directory leaves tens of thousands of
// read-ahead tasks queued. Draining them on close must not recurse per task
// (stack overflow would replace the limit error with a RangeError).
let root: string;
beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "prefetch-close-"));
	for (let i = 0; i < 30000; i++) {
		await fs.writeFile(path.join(root, `f${i}.md`), "x");
	}
}, 120_000);
afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

it("surfaces the limit error, not a stack overflow, with a large prefetch queue", async () => {
	await expect(
		discoverWorkspaceFiles({
			workspaceRoot: root,
			isSupportedFile: (p) => p.endsWith(".md"),
			maxEntries: 1,
		}),
	).rejects.toBeInstanceOf(WorkspaceTraversalLimitError);
}, 120_000);
