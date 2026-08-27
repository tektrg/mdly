import { discoverWorkspaceFiles } from "@mdly/workspace-kit/file-discovery";
import type { DirectoryListing } from "../src/desktopApi/types";
import {
	hasDocumentExtension,
	isHiddenSidebarFolderName,
} from "../src/lib/filePath";

export type DocumentDiscoveryOptions = {
	includeIgnoredWorkspaceFiles?: boolean;
};

export async function collectDocumentFiles(
	dir: string,
	out: DirectoryListing,
	options: DocumentDiscoveryOptions = {},
): Promise<void> {
	const discovery = await discoverWorkspaceFiles({
		workspaceRoot: dir,
		isSupportedFile: hasDocumentExtension,
		isVisibleFolderName: (folderName) => !isHiddenSidebarFolderName(folderName),
		includeIgnoredWorkspaceFiles: options.includeIgnoredWorkspaceFiles,
	});
	out.files.push(...discovery.files);
	out.folders.push(...discovery.folders);
}
