import { basename, relativeWorkspacePath } from "./filePath";

export type BacklinkMenuEntry = {
	path: string;
	/** File name; the workspace-relative path when two linkers share it. */
	label: string;
	/** Workspace-relative path, for the item's tooltip. */
	title: string;
};

const DOC_EXTENSION_RE = /\.(md|markdown|mdown)$/i;

/**
 * One entry per linking document, sorted A→Z. Same-named linkers (a/index,
 * b/index) show their folder so they differ, like the "Linked from" headers.
 */
export function backlinkMenuEntries(
	sourcePaths: readonly string[],
	workspacePath: string | null,
): BacklinkMenuEntry[] {
	const unique = [...new Set(sourcePaths)];
	const names = unique.map((path) =>
		basename(path).replace(DOC_EXTENSION_RE, ""),
	);
	const counts = new Map<string, number>();
	for (const name of names)
		counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
	return unique
		.map((path, i) => {
			const title = relativeWorkspacePath(path, workspacePath);
			const name = names[i] ?? path;
			return {
				path,
				label:
					(counts.get(name.toLowerCase()) ?? 0) > 1
						? title.replace(DOC_EXTENSION_RE, "")
						: name,
				title,
			};
		})
		.sort((a, b) =>
			a.label.localeCompare(b.label, undefined, {
				sensitivity: "base",
				numeric: true,
			}),
		);
}
