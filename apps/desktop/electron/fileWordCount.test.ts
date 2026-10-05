import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { countWords, readFileHeadAndStats } from "./fileWordCount";
import {
	frontMatterBlock,
	scanFrontMatterProperties,
} from "./frontMatterProperties";

describe("countWords", () => {
	it("counts runs with a letter or digit; Markdown syntax alone is not a word", () => {
		expect(countWords("")).toBe(0);
		expect(countWords("# Title\n\n- one, two\t3 — don't")).toBe(5);
		expect(countWords("| a | b |\n|---|---|")).toBe(2);
		expect(countWords("Tiếng Việt có dấu")).toBe(4);
		expect(countWords("“quoted” … end")).toBe(2);
	});

	it("finds the front-matter block to subtract", () => {
		expect(frontMatterBlock("---\na: b c\n---\nbody")).toBe(
			"---\na: b c\n---\n",
		);
		expect(frontMatterBlock("no fm")).toBe("");
		expect(frontMatterBlock("---\nnever closes")).toBe("");
	});
});

describe("whole-file stats", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "mdly-words-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("streams files bigger than one chunk, counting words across chunk edges", async () => {
		const file = path.join(dir, "big.md");
		// 30k words of 4 bytes + space = 150 KB: spans three 64 KB chunks.
		writeFileSync(file, "word ".repeat(30_000));
		const stats = await readFileHeadAndStats(file, 8192);
		expect(stats?.sizeBytes).toBe(150_000);
		expect(stats?.wordCount).toBe(30_000);
		expect(stats?.head.length).toBe(8192);
	});

	it("yields to the event loop between chunks", async () => {
		const file = path.join(dir, "yield.md");
		writeFileSync(file, "word ".repeat(400_000)); // 2 MB = 31 chunks
		let ticks = 0;
		const ticker = setInterval(() => ticks++, 0);
		const stats = await readFileHeadAndStats(file, 8192);
		clearInterval(ticker);
		expect(stats?.wordCount).toBe(400_000);
		expect(ticks).toBeGreaterThan(0);
	});

	// Writes 50k files (~80 MB) to tmp: opt-in. `MDLY_PERF=1 pnpm vitest run electron/fileWordCount.test.ts`
	// 2026-10-05 Pro: heads-only 9.2 s, with word count 7.9 s (1.6 KB/file, warm cache).
	it.skipIf(!process.env.MDLY_PERF)(
		"50k files: head-only vs whole-file scan time",
		async () => {
			const scanDir = mkdtempSync(path.join(dir, "ws-"));
			const body = `---\nstatus: Done\ntags: [a, b]\n---\n${"Some words in a note body. ".repeat(60)}`;
			const paths = Array.from({ length: 50_000 }, (_, index) =>
				path.join(scanDir, `n${index}.md`),
			);
			for (const filePath of paths) writeFileSync(filePath, body);
			const timed = async (includeStats: boolean) => {
				const start = performance.now();
				const result = await scanFrontMatterProperties(paths, { includeStats });
				return { ms: performance.now() - start, result };
			};
			const heads = await timed(false);
			const whole = await timed(true);
			console.info(
				`[perf 50k] property scan heads-only ${heads.ms.toFixed(0)} ms, with word count ${whole.ms.toFixed(0)} ms (${(body.length / 1024).toFixed(1)} KB/file)`,
			);
			expect(Object.keys(whole.result.statsByPath ?? {})).toHaveLength(50_000);
			expect(whole.result.statsByPath?.[paths[0] as string]?.wordCount).toBe(
				360,
			);
			rmSync(scanDir, { recursive: true, force: true });
		},
		120_000,
	);
});
