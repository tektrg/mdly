import path from "node:path";

/**
 * Mirrors `apps/desktop/src/lib/filePath.ts`'s `isHiddenSidebarFolderName`.
 * Duplicated here (rather than imported) because this package is pure Node
 * and must not depend on the desktop app — keep the two in sync if the Mac
 * app's hidden-folder rule ever changes.
 */
export function isHiddenSidebarFolderName(name: string): boolean {
	return name === ".hubble" || name === ".mdly" || name.endsWith(".assets");
}

export function toWorkspaceRelativePath(
	absolutePath: string,
	workspaceRoot: string,
): string {
	return path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
}
