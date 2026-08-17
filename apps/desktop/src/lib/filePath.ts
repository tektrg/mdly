const MARKDOWN_EXTENSION_RE = /\.(md|markdown|mdown)$/i;
const HTML_EXTENSION_RE = /\.html?$/i;

export function dirname(filePath: string): string | null {
	const forwardSlash = filePath.lastIndexOf("/");
	const backSlash = filePath.lastIndexOf("\\");
	const separatorIndex = Math.max(forwardSlash, backSlash);
	if (separatorIndex < 0) return null;
	if (separatorIndex === 0) return filePath.slice(0, 1);
	return filePath.slice(0, separatorIndex);
}

export function basename(filePath: string): string {
	return filePath.split(/[\\/]/).pop() ?? filePath;
}

export function extname(filePath: string): string {
	const name = basename(filePath);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot) : "";
}

export function hasMarkdownExtension(path: string): boolean {
	return MARKDOWN_EXTENSION_RE.test(path);
}

export function hasHtmlExtension(path: string): boolean {
	return HTML_EXTENSION_RE.test(path);
}

export function hasDocumentExtension(path: string): boolean {
	return hasMarkdownExtension(path) || hasHtmlExtension(path);
}

export function isHiddenSidebarFolderName(name: string): boolean {
	return name === ".hubble" || name === ".mdly" || name.endsWith(".assets");
}

export function withMarkdownExtension(path: string): string {
	return hasMarkdownExtension(path) ? path : `${path}.md`;
}

export function markdownAssetFolderPath(path: string): string | null {
	const parent = dirname(path);
	if (!parent) return null;
	const extension = extname(path);
	const stem = extension
		? basename(path).slice(0, -extension.length)
		: basename(path);
	return joinPath(parent, `${stem}.assets`);
}

export function joinPath(parent: string, name: string): string {
	const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
	return parent.endsWith("/") || parent.endsWith("\\")
		? `${parent}${name}`
		: `${parent}${separator}${name}`;
}

export function normalizePath(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const isAbsolute = normalized.startsWith("/");
	const parts: string[] = [];
	for (const part of normalized.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
			else if (!isAbsolute) parts.push(part);
			continue;
		}
		parts.push(part);
	}
	return `${isAbsolute ? "/" : ""}${parts.join("/")}`;
}

export function pathEquals(a: string, b: string): boolean {
	return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

export function pathInFolder(path: string, folderPath: string): boolean {
	const prefix =
		folderPath.endsWith("/") || folderPath.endsWith("\\")
			? folderPath
			: `${folderPath}/`;
	return path.startsWith(prefix);
}

export function replacePathPrefix(
	path: string,
	fromPath: string,
	toPath: string,
) {
	if (pathEquals(path, fromPath)) return toPath;
	if (!pathInFolder(path, fromPath)) return path;
	return joinPath(
		toPath,
		path.slice(fromPath.replace(/[\\/]+$/, "").length + 1),
	);
}

export function absoluteWorkspacePath(
	relativePath: string,
	workspacePath: string,
) {
	return workspacePath.endsWith("/")
		? `${workspacePath}${relativePath}`
		: `${workspacePath}/${relativePath}`;
}

export function relativeWorkspacePath(
	path: string,
	workspacePath: string | null,
) {
	if (!workspacePath) return path;
	const prefix = workspacePath.endsWith("/")
		? workspacePath
		: `${workspacePath}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
