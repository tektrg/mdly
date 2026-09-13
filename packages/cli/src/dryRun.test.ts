import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assetsWalker, notesWalker } from "@mdly/workspace-scan";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeDryRunReport } from "./dryRun.js";

let workspaceRoot: string;

async function writeFixture(relativePath: string, content = "") {
	const absolutePath = path.join(workspaceRoot, relativePath);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, content);
}

describe("computeDryRunReport (R16)", () => {
	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dry-run-"));
	});

	afterEach(async () => {
		await fs.rm(workspaceRoot, { recursive: true, force: true });
		vi.unstubAllGlobals();
	});

	it("reuses the real notes+assets walkers — output equals their combined result for a mixed fixture", async () => {
		await writeFixture(".gitignore", "ignored.md\n");
		await writeFixture("ignored.md", "should not sync");
		await writeFixture(".somefolder/note.md", "dot-folder note");
		await writeFixture("normal.md", "plain note");
		await writeFixture("image.assets/photo.png", "fake-png-bytes");

		const [notes, assets] = await Promise.all([
			notesWalker(workspaceRoot),
			assetsWalker(workspaceRoot),
		]);
		const expected = [...notes.files, ...assets.files].sort();

		const report = await computeDryRunReport(workspaceRoot);

		expect(report.wouldSync).toEqual(expected);
	});

	it("makes zero network calls", async () => {
		await writeFixture("note.md", "hello");
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		await computeDryRunReport(workspaceRoot);

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("separates a newly-exposed dot-folder file from a gitignored one inside another dot-folder", async () => {
		await writeFixture(".exposed/visible.md", "now syncs");
		await writeFixture(".excluded/.gitignore", "secret.md\n");
		await writeFixture(".excluded/secret.md", "still hidden");

		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const report = await computeDryRunReport(workspaceRoot);

		expect(report.wouldSync).toEqual([".exposed/visible.md"]);
		expect(report.newlyExposed).toEqual([".exposed/visible.md"]);
		expect(report.wouldSync).not.toContain(".excluded/secret.md");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	// QA6b — dry-run is scoped per workspace, no cross-workspace leak.
	it("is scoped to the given workspace path only, with no cross-workspace leak", async () => {
		const otherRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "dry-run-other-"),
		);
		try {
			await writeFixture("workspace-a-note.md", "a");
			await fs.writeFile(path.join(otherRoot, "workspace-b-note.md"), "b");

			const reportA = await computeDryRunReport(workspaceRoot);
			const reportB = await computeDryRunReport(otherRoot);

			expect(reportA.wouldSync).toEqual(["workspace-a-note.md"]);
			expect(reportB.wouldSync).toEqual(["workspace-b-note.md"]);
			expect(reportA.wouldSync).not.toContain("workspace-b-note.md");
			expect(reportB.wouldSync).not.toContain("workspace-a-note.md");
		} finally {
			await fs.rm(otherRoot, { recursive: true, force: true });
		}
	});
});
