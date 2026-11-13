import { useStoreValue } from "@simplestack/store/react";
import { useEffect } from "react";
import { desktopApi } from "../desktopApi";
import { buildDocumentRows } from "../documentTable/documentTableView";
import { linkIndexStore, syncLinkIndex } from "./linkIndexStore";
import { workspacePathStore, workspaceStore } from "./state";

/**
 * Keeps the link index in sync with the listing while `enabled` (the
 * ⋯ menu Backlinks submenu, a saved view grouped by "Linked from"). The first enabled
 * render starts the index; later listing changes read only changed files.
 */
export function useLinkIndexSync(enabled: boolean) {
	const workspacePath = useStoreValue(workspacePathStore);
	const files = useStoreValue(workspaceStore, (workspace) => workspace.files);
	// A reset (workspace close, "Try again") drops the scope: re-run then.
	const scope = useStoreValue(linkIndexStore, (state) => state.scope);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `scope` is the reset signal, not a value read here
	useEffect(() => {
		if (!enabled || !workspacePath) return;
		const rows = buildDocumentRows(files, workspacePath).map((row) => ({
			path: row.path,
			modifiedAt: row.modifiedAt,
		}));
		void syncLinkIndex(workspacePath, rows, (path) =>
			desktopApi.readFileText(path),
		);
	}, [enabled, workspacePath, files, scope]);
}
