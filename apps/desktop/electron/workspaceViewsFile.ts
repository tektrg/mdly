/**
 * Desktop (L0) adapter for the saved-view `ViewStore` port:
 * `<workspace>/.hubble/views.json`. The writer itself (atomic temp+rename,
 * sha256 compare-and-swap, corrupt-file backup) lives in
 * `@tektrg/table-core/node` so the `hubble views` CLI and the MCP tools write
 * the file exactly the same way (saved views outside the app R10).
 */
export {
	createWorkspaceViewStore,
	VIEWS_DIR_NAME,
	VIEWS_FILE_NAME,
	viewsFilePath,
	type WorkspaceViewStoreOptions,
} from "@tektrg/table-core/node";
