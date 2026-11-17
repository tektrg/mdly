import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendHookEvent,
	docKey,
	eventsPath,
	hookDir,
	newHookEvent,
	readHookEvents,
	readSeen,
	writeSeen,
} from "./events.js";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hook-key-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

const longName = `${"Very long note title ".repeat(20)}.md`; // ~420 chars
const nested = `${"deep folder name/".repeat(8)}${longName}`;

describe("doc file names", () => {
	it("stay under the file-name limit for very long note names", async () => {
		for (const doc of [longName, nested, `${"é".repeat(200)}.md`]) {
			expect(
				Buffer.byteLength(path.basename(eventsPath(root, doc))),
			).toBeLessThan(200);
			await appendHookEvent(
				root,
				newHookEvent("comment.added", doc, "user", { text: "hi" }),
			);
			expect((await readHookEvents(root, doc)).map((e) => e.doc)).toEqual([
				doc,
			]);
			await writeSeen(root, doc, "seen");
			expect(await readSeen(root, doc)).toBe("seen");
		}
	});

	it("are distinct for names sharing a long prefix, and stable", () => {
		const a = `${longName}a.md`;
		const b = `${longName}b.md`;
		expect(docKey(a)).not.toBe(docKey(b));
		expect(docKey(a)).toBe(docKey(a));
		expect(docKey("x/y.md")).toMatch(/^[\w.-]+$/);
	});

	it("hostile names are inert", async () => {
		const doc = "$(echo INJECTED).md";
		await appendHookEvent(root, newHookEvent("comment.added", doc, "user"));
		const files = await fs.readdir(hookDir(root));
		expect(files.join()).not.toContain("INJECTED\n");
		expect((await readHookEvents(root, doc))[0].doc).toBe(doc);
	});

	it("migrates a stream written under the old encoded name", async () => {
		const doc = "notes/a.md";
		await fs.mkdir(hookDir(root), { recursive: true });
		const legacy = path.join(
			hookDir(root),
			`${encodeURIComponent(doc)}.events.jsonl`,
		);
		await fs.writeFile(
			legacy,
			`${JSON.stringify(newHookEvent("comment.added", doc, "user", { text: "old" }))}\n`,
		);
		await fs.writeFile(
			path.join(hookDir(root), `${encodeURIComponent(doc)}.seen.md`),
			"old seen",
		);
		expect((await readHookEvents(root, doc)).map((e) => e.text)).toEqual([
			"old",
		]);
		expect(await readSeen(root, doc)).toBe("old seen");
	});
});
