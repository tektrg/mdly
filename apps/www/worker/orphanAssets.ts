import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

type MarkdownFile = {
	path: string;
	content: string;
	deleted: boolean;
};

type Asset = {
	path: string;
	deleted: boolean;
	orphanedAt?: number;
};

const ASSET_DEVICE_ID = "asset-orphan-cleanup";
const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

export type OrphanAssetCandidate = {
	path: string;
	orphanedAt?: number;
};

/**
 * Admin-level reachability scan for asset cleanup.
 *
 * This intentionally parses every live markdown file and should only be used
 * from manual or scheduled maintenance flows. It is not a hot-path primitive
 * for editor saves or sync pushes. A scalable cleanup component should maintain
 * an incremental reference index as files change, then use that index here.
 */
export function referencedAssetPaths(files: MarkdownFile[]): Set<string> {
	const references = new Set<string>();
	for (const file of files) {
		if (file.deleted) continue;
		const noteDir = parentDir(file.path);
		for (const rawPath of markdownImageDestinations(file.content)) {
			const path = normalizeMarkdownAssetPath(rawPath, noteDir);
			if (path) references.add(path);
		}
	}
	return references;
}

/**
 * Returns assets with zero markdown references at scan time.
 *
 * Candidates are not safe to delete immediately: undo, cut/paste, sync ordering,
 * and shared references can make a single scan temporarily incomplete. Callers
 * should first mark candidates with `orphanedAt`, then delete only after a grace
 * period if a later scan still finds no references.
 */
export function orphanAssetCandidates(
	files: MarkdownFile[],
	assets: Asset[],
): OrphanAssetCandidate[] {
	const references = referencedAssetPaths(files);
	return assets
		.filter((asset) => !asset.deleted && !references.has(asset.path))
		.map((asset) => ({
			path: asset.path,
			orphanedAt: asset.orphanedAt,
		}));
}

export function assetCleanupDeviceId(): string {
	return ASSET_DEVICE_ID;
}

function markdownImageDestinations(markdown: string): string[] {
	const destinations: string[] = [];
	const tree = markdownProcessor.parse(markdown);
	visit(tree, "image", (node) => {
		if (typeof node.url === "string") destinations.push(node.url);
	});
	return destinations;
}

function normalizeMarkdownAssetPath(
	rawDestination: string,
	noteDir: string,
): string | null {
	const withoutFragment = rawDestination.split("#", 1)[0];
	const withoutQuery = withoutFragment.split("?", 1)[0];
	if (!withoutQuery || isExternalDestination(withoutQuery)) return null;
	const decoded = decodePath(withoutQuery);
	if (!isAssetPath(decoded)) return null;
	return normalizeWorkspacePath(
		decoded.startsWith("/")
			? decoded.slice(1)
			: joinWorkspacePath(noteDir, decoded),
	);
}

function isExternalDestination(path: string): boolean {
	return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path);
}

function isAssetPath(path: string): boolean {
	return path.split("/").some((part) => part.endsWith(".assets"));
}

function decodePath(path: string): string {
	try {
		return decodeURI(path);
	} catch {
		return path;
	}
}

function parentDir(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

function joinWorkspacePath(dir: string, path: string): string {
	return dir ? `${dir}/${path}` : path;
}

function normalizeWorkspacePath(path: string): string | null {
	const parts: string[] = [];
	for (const part of path.replaceAll("\\", "/").split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return parts.join("/");
}
