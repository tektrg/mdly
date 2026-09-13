import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assetsWalker, notesWalker } from "@mdly/workspace-scan";

export type DryRunReport = {
	workspacePath: string;
	/** Every file that would sync under the new ignore rules — the combined
	 * notes + assets walker output for this workspace, unmodified (R16). */
	wouldSync: string[];
	/** Files inside a dot-folder that the OLD blanket dot-skip rule always
	 * hid, and would now newly start syncing (D1's "would newly sync"). */
	newlyExposed: string[];
	/** Files the old rule would have synced that the new .gitignore-aware
	 * rules now exclude — informational, so nothing goes quiet unexplained. */
	noLongerSynced: string[];
};

const OLD_NOTE_EXTENSIONS = new Set(["md", "markdown", "mdown"]);
const OLD_IMAGE_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"bmp",
	"svg",
	"webp",
]);
const OLD_MAX_ASSET_SIZE = 10 * 1024 * 1024; // 10 MB

/**
 * The rule this command replaces: `packages/sync/src/fs-node.ts` before
 * slice 1.3 — skip every dot-prefixed entry, honor no ignore file at all.
 * Reimplemented here locally (a few lines), purely to compute the dry run's
 * set difference. Deliberately NOT imported from `packages/sync` — that
 * package has already been switched onto the new walkers by this same
 * delivery, so the old rule no longer exists there to import.
 */
async function oldRuleWalk(
	root: string,
	dir: string,
	out: string[],
): Promise<void> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await oldRuleWalk(root, full, out);
			continue;
		}
		const ext = entry.name.split(".").pop()?.toLowerCase();
		if (ext && OLD_NOTE_EXTENSIONS.has(ext)) {
			out.push(path.relative(root, full).split(path.sep).join("/"));
			continue;
		}
		if (ext && OLD_IMAGE_EXTENSIONS.has(ext)) {
			try {
				const stat = await fs.stat(full);
				if (stat.size <= OLD_MAX_ASSET_SIZE) {
					out.push(path.relative(root, full).split(path.sep).join("/"));
				}
			} catch {
				// Unreadable — the old rule would have failed on it too.
			}
		}
	}
}

/**
 * Computes the D1 dry-run report for ONE workspace. Reuses the same
 * notes+assets walkers slice 1.3 ships (no ad-hoc re-implementation of the
 * new rules) and makes zero network calls (R16) — nothing here constructs a
 * SyncBackend of any kind.
 */
export async function computeDryRunReport(
	workspacePath: string,
): Promise<DryRunReport> {
	const root = path.resolve(workspacePath);
	const [notes, assets] = await Promise.all([
		notesWalker(root),
		assetsWalker(root),
	]);
	const wouldSync = [...notes.files, ...assets.files].sort();

	const oldRuleFiles: string[] = [];
	await oldRuleWalk(root, root, oldRuleFiles);
	const oldRuleSet = new Set(oldRuleFiles);
	const newRuleSet = new Set(wouldSync);

	const newlyExposed = wouldSync.filter((file) => !oldRuleSet.has(file));
	const noLongerSynced = oldRuleFiles
		.filter((file) => !newRuleSet.has(file))
		.sort();

	return { workspacePath: root, wouldSync, newlyExposed, noLongerSynced };
}

export function formatDryRunReport(report: DryRunReport): string {
	const lines: string[] = [];
	lines.push(`Cloud Sync dry run: ${report.workspacePath}`);
	lines.push("");
	lines.push(`Would sync (${report.wouldSync.length}):`);
	for (const file of report.wouldSync) lines.push(`  ${file}`);

	if (report.newlyExposed.length > 0) {
		lines.push("");
		lines.push(
			`Newly exposed by the new ignore rules (${report.newlyExposed.length}) — inside a dot-folder the old rule always skipped:`,
		);
		for (const file of report.newlyExposed) lines.push(`  + ${file}`);
	}

	if (report.noLongerSynced.length > 0) {
		lines.push("");
		lines.push(
			`No longer synced under the new .gitignore-aware rules (${report.noLongerSynced.length}) — add a .gitignore entry if this is intentional:`,
		);
		for (const file of report.noLongerSynced) lines.push(`  - ${file}`);
	}

	if (report.newlyExposed.length === 0 && report.noLongerSynced.length === 0) {
		lines.push("");
		lines.push("No change from the old sync rules for this workspace.");
	}

	return lines.join("\n");
}

/** Thin console wrapper — kept separate from computeDryRunReport so tests
 * assert on structured data, not stdout. */
export async function runDryRunCommand(
	workspacePath: string,
): Promise<DryRunReport> {
	const report = await computeDryRunReport(workspacePath);
	console.log(formatDryRunReport(report));
	return report;
}
