import type { FileEntry } from "../store/state";
import {
	applyDocumentTableView,
	buildDocumentRows,
	createDefaultDocumentTableView,
	type DocumentTableRow,
	type DocumentTableView,
	resetDocumentRowsMemo,
} from "./documentTableView";

export const WORKSPACE_PATH = "/ws";

export const WORKSPACE_FILES: FileEntry[] = [
	{ path: "/ws/alpha.md", modified_at: 1_700_000_300 },
	{ path: "/ws/notes/beta.markdown", modified_at: 1_700_000_200 },
	{ path: "/ws/notes/deep/gamma.md", modified_at: 1_700_000_100 },
	{ path: "/ws/app.html", modified_at: 1_700_000_900 },
	{ path: "/ws/cover.png", modified_at: 1_700_000_800 },
];

/** Builds the rows a component would receive, through the real row model. */
export function buildRows(
	options: {
		files?: FileEntry[];
		view?: DocumentTableView;
		activePath?: string | null;
	} = {},
): DocumentTableRow[] {
	resetDocumentRowsMemo();
	const files = options.files ?? WORKSPACE_FILES;
	const view = options.view ?? createDefaultDocumentTableView();
	return applyDocumentTableView(
		buildDocumentRows(files, WORKSPACE_PATH),
		view,
		options.activePath ?? null,
	);
}

export function viewWith(
	overrides: Partial<DocumentTableView> = {},
): DocumentTableView {
	return { ...createDefaultDocumentTableView(), ...overrides };
}

export function manyMarkdownFiles(count: number): FileEntry[] {
	return Array.from({ length: count }, (_unused, index) => ({
		path: `/ws/note-${String(index).padStart(4, "0")}.md`,
		modified_at: 1_700_000_000 + index,
	}));
}
