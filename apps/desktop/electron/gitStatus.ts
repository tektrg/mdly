import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DirectoryListing, GitFileStatus } from "../src/desktopApi/types";

const execFileAsync = promisify(execFile);
const GIT_STATUS_MAX_BUFFER_BYTES = 1024 * 1024 * 10;

export async function applyGitStatusToListing(
	workspacePath: string,
	listing: DirectoryListing,
) {
	const statuses = await collectGitFileStatuses(workspacePath);
	if (statuses.size === 0) return;

	listing.files = await Promise.all(
		listing.files.map(async (file) => {
			if (file.is_symlink) return file;
			const gitStatus =
				statuses.get(file.path) ?? statuses.get(await realFilePath(file.path));
			return gitStatus ? { ...file, git_status: gitStatus } : file;
		}),
	);
}

async function realFilePath(filePath: string) {
	try {
		return await fs.realpath(filePath);
	} catch {
		return filePath;
	}
}

async function collectGitFileStatuses(workspacePath: string) {
	try {
		const [{ stdout }, repoRoot] = await Promise.all([
			execFileAsync(
				"git",
				[
					"-C",
					workspacePath,
					"status",
					"--porcelain=v1",
					"-z",
					"--untracked-files=all",
				],
				{
					encoding: "utf8",
					maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
				},
			),
			gitRepoRoot(workspacePath),
		]);
		return parseGitStatusPorcelain(stdout, repoRoot);
	} catch {
		return new Map<string, GitFileStatus>();
	}
}

async function gitRepoRoot(workspacePath: string) {
	const { stdout } = await execFileAsync(
		"git",
		["-C", workspacePath, "rev-parse", "--show-toplevel"],
		{
			encoding: "utf8",
			maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
		},
	);
	return stdout.trim();
}

export function parseGitStatusPorcelain(
	output: string,
	repoRoot: string,
): Map<string, GitFileStatus> {
	const statuses = new Map<string, GitFileStatus>();
	const records = output.split("\0");

	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) continue;

		const statusCode = record.slice(0, 2);
		const relativePath = record.slice(3);
		if (!relativePath) continue;

		statuses.set(
			path.resolve(repoRoot, relativePath),
			statusCode === "??" ? "untracked" : "changed",
		);

		if (statusCode.includes("R") || statusCode.includes("C")) index++;
	}

	return statuses;
}
