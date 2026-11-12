import { SidePanel } from "@mdly/workspace-kit";
import { store } from "@simplestack/store";
import { useStoreValue } from "@simplestack/store/react";
import { useEffect, useMemo } from "react";
import { desktopApi } from "../desktopApi";
import { buildDocumentRows } from "../documentTable/documentTableView";
import { relativeWorkspacePath } from "../lib/filePath";
import { backlinksFor, outgoingFor } from "../lib/linkIndex";
import { loadPath } from "../store/actions";
import {
	currentLinkIndex,
	linkIndexStore,
	syncLinkIndex,
} from "../store/linkIndexStore";
import { workspacePathStore, workspaceStore } from "../store/state";

/**
 * Open state for the right-edge Backlinks panel. A store rather than App
 * state so the toolbar, App's one-panel-at-a-time rule (R21) and
 * `ReadyDocument` can share it without threading props through MainPanel.
 */
export const backlinksOpenStore = store(false);

export function setBacklinksOpen(open: boolean) {
	backlinksOpenStore.set(open);
}

/** Keeps the link index in sync with the listing while `enabled`. */
function useLinkIndexSync(enabled: boolean) {
	const workspacePath = useStoreValue(workspacePathStore);
	const files = useStoreValue(workspaceStore, (workspace) => workspace.files);
	useEffect(() => {
		if (!enabled || !workspacePath) return;
		const rows = buildDocumentRows(files, workspacePath).map((row) => ({
			path: row.path,
			modifiedAt: row.modifiedAt,
		}));
		void syncLinkIndex(workspacePath, rows, (path) =>
			desktopApi.readFileText(path),
		);
	}, [enabled, workspacePath, files]);
}

export function BacklinksPanel({ path }: { path: string }) {
	const open = useStoreValue(backlinksOpenStore);
	const workspacePath = useStoreValue(workspacePathStore);
	const { status, version } = useStoreValue(linkIndexStore);
	useLinkIndexSync(open);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the change signal for the mutable index.
	const { backlinks, outgoingCount } = useMemo(() => {
		const index = currentLinkIndex();
		return {
			backlinks: backlinksFor(index, path),
			outgoingCount: outgoingFor(index, path).length,
		};
	}, [path, version]);

	const pending = status === "indexing" || status === "idle";

	return (
		<SidePanel open={open} onOpenChange={setBacklinksOpen} title="Backlinks">
			<p className="m-0 mb-2 text-[11px] text-muted-foreground tabular-nums">
				{pending
					? "Indexing links…"
					: `${backlinks.length} linking ${backlinks.length === 1 ? "reference" : "references"} · ${outgoingCount} outgoing`}
			</p>
			{!pending && backlinks.length === 0 ? (
				<p className="m-0 rounded-mdly-control bg-mdly-control px-3 py-6 text-center text-muted-foreground text-xs">
					{status === "failed"
						? "Couldn't read the workspace to find links."
						: "No documents link here yet."}
				</p>
			) : (
				<ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1 overflow-y-auto p-0">
					{backlinks.map((link) => (
						<li key={`${link.sourcePath}:${link.line}:${link.snippet}`}>
							<button
								type="button"
								onClick={() => void loadPath(link.sourcePath)}
								className="flex w-full flex-col gap-0.5 rounded-mdly-control px-2.5 py-2 text-start text-[12px] outline-hidden transition-colors duration-150 ease-snappy hover:bg-mdly-control focus-visible:ring-2 focus-visible:ring-mdly-ink/20 motion-reduce:transition-none"
							>
								<span className="truncate font-medium text-mdly-strong">
									{relativeWorkspacePath(
										link.sourcePath,
										workspacePath ?? null,
									)}
								</span>
								<span className="line-clamp-2 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
									{link.snippet}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</SidePanel>
	);
}
