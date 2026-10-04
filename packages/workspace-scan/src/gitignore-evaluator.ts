import fs from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import { rootExtraIgnoreFiles } from "./file-discovery.js";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore"];

export type GitignoreEvaluator = {
	/** Whether `.gitignore`/`.ignore` (nested, with negation) hide this absolute path. */
	isIgnored(absolutePath: string): Promise<boolean>;
	/** Drops cached rules — call when an ignore file itself changes. */
	invalidate(): void;
	/** True for paths that are ignore files (their change must invalidate). */
	isIgnoreFile(absolutePath: string): boolean;
};

async function readIfPresent(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch {
		return null;
	}
}

/**
 * Evaluates gitignore rules for paths a watcher REPORTS, instead of walking
 * the tree or adding per-file watchers (a 41k-handle watcher hung quit —
 * see cloudSyncWiring). Each ancestor directory's ignore files are read once
 * and cached until `invalidate()`.
 */
export function createGitignoreEvaluator(
	workspaceRoot: string,
): GitignoreEvaluator {
	const root = path.resolve(workspaceRoot);
	const matcherByDir = new Map<
		string,
		Promise<ReturnType<typeof ignore> | null>
	>();

	const loadMatcher = (dir: string) => {
		let pending = matcherByDir.get(dir);
		if (!pending) {
			pending = (async () => {
				const files = IGNORE_FILE_NAMES.map((name) => path.join(dir, name));
				if (dir === root)
					files.push(...rootExtraIgnoreFiles({ workspaceRootPath: root }));
				const contents = await Promise.all(files.map(readIfPresent));
				const present = contents.filter((text): text is string => !!text);
				return present.length > 0 ? ignore().add(present.join("\n")) : null;
			})();
			matcherByDir.set(dir, pending);
		}
		return pending;
	};

	/** Last matching rule across root..parent ignore files decides, as in git. */
	const isPathIgnored = async (segments: string[], isFolder: boolean) => {
		let ignored = false;
		let dir = root;
		for (let index = 0; index < segments.length; index += 1) {
			const matcher = await loadMatcher(dir);
			if (matcher) {
				const rel = segments.slice(index).join("/");
				const result = matcher.test(isFolder ? `${rel}/` : rel);
				if (result.ignored) ignored = true;
				if (result.unignored) ignored = false;
			}
			dir = path.join(dir, segments[index] ?? "");
		}
		return ignored;
	};

	return {
		async isIgnored(absolutePath) {
			const relative = path.relative(root, absolutePath);
			if (
				relative === "" ||
				relative.startsWith("..") ||
				path.isAbsolute(relative)
			)
				return false;
			const segments = relative.split(path.sep);
			// Git cannot re-include a path whose parent folder is excluded, so
			// each ancestor folder is judged first; an ignored one wins outright.
			for (let depth = 1; depth < segments.length; depth += 1) {
				if (await isPathIgnored(segments.slice(0, depth), true)) return true;
			}
			// The reported path itself may be a file or a folder.
			return (
				(await isPathIgnored(segments, false)) ||
				(await isPathIgnored(segments, true))
			);
		},
		invalidate() {
			matcherByDir.clear();
		},
		isIgnoreFile(absolutePath) {
			return IGNORE_FILE_NAMES.includes(path.basename(absolutePath));
		},
	};
}
