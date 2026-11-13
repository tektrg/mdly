import { withMarkdownExtension } from "@mdly/workspace-kit/engine";
import type { FileEntry } from "../store/state";
import { joinPath } from "./filePath";
import {
	resolveWikiTargetAmong,
	splitWikiLink,
	wikiCandidatesFromPaths,
} from "./linkIndex";

/**
 * Editor click-to-open for `[[…]]`. Uses the link index's rule
 * (`resolveWikiTargetAmong`), so a click opens the same file Backlinks counts.
 * Alias and `#section` are dropped (the click opens the file, no section jump).
 * Unresolved: an absolute target opens as written, else the root-joined path.
 */
export function resolveWikiPath({
	target,
	files,
	workspacePath,
	sourcePath,
}: {
	target: string;
	files: FileEntry[];
	workspacePath: string | null;
	sourcePath: string | null;
}) {
	const path = splitWikiLink(target).target;
	const resolved = path
		? resolveWikiTargetAmong(
				wikiCandidatesFromPaths(
					workspacePath,
					files.map((file) => file.path),
				),
				sourcePath ?? joinPath(workspacePath ?? "/", "_"),
				path,
			)
		: null;
	if (resolved) return resolved;
	const pathWithExtension = withMarkdownExtension(path);
	if (pathWithExtension.startsWith("/")) return pathWithExtension;
	return workspacePath
		? joinPath(workspacePath, pathWithExtension)
		: pathWithExtension;
}
