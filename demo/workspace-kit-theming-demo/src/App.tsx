import {
	EditorView,
	NewNoteButton,
	PortalContainerProvider,
	Sidebar,
	type SidebarFile,
	type SidebarSortMode,
	Toolbar,
	WorkspaceSwitcherMenu,
} from "@mdly/workspace-kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import { GETTING_STARTED_MARKDOWN, NOTES_MARKDOWN } from "./sampleContent";

type ThemeName = "mdly" | "speechtodo";

const INITIAL_FILES: SidebarFile[] = [
	{ path: "Getting Started.md", modifiedAt: Date.now() },
	{ path: "Notes.md", modifiedAt: Date.now() - 60_000 },
];

const INITIAL_CONTENT: Record<string, string> = {
	"Getting Started.md": GETTING_STARTED_MARKDOWN,
	"Notes.md": NOTES_MARKDOWN,
};

export function App() {
	// R27: the wrapper is captured via useState + a ref callback -- NOT a
	// one-time `useRef().current` read taken during render, which would be
	// `null` on first render and never update. The ref callback fires the
	// moment React commits the DOM node, re-rendering with the real element so
	// `PortalContainerProvider` (and therefore every popup) picks it up live.
	const [wrapperEl, setWrapperEl] = useState<HTMLDivElement | null>(null);

	const [theme, setTheme] = useState<ThemeName>("mdly");
	const [emptyMode, setEmptyMode] = useState(false);
	const [constrained, setConstrained] = useState(false);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(true);

	const [files, setFiles] = useState<SidebarFile[]>(INITIAL_FILES);
	const [content, setContent] =
		useState<Record<string, string>>(INITIAL_CONTENT);
	const [currentPath, setCurrentPath] = useState<string | null>(
		"Getting Started.md",
	);
	const [sortMode, setSortMode] = useState<SidebarSortMode>("alpha");

	const activeFiles = emptyMode ? [] : files;
	const activePath = emptyMode ? null : currentPath;

	const onSelectFile = useCallback((path: string) => setCurrentPath(path), []);

	const onCreateFile = useCallback(async () => {
		const path = `Untitled ${files.length + 1}.md`;
		setFiles((prev) => [...prev, { path, modifiedAt: Date.now() }]);
		setContent((prev) => ({ ...prev, [path]: "" }));
		setCurrentPath(path);
		return path;
	}, [files.length]);

	// Renaming to a name that collides with an existing sibling is validated
	// *inside* the kit's own Sidebar (it never calls this at all in that case
	// -- see QA6-a) -- this only runs for a successful, non-colliding rename.
	const onRenameFile = useCallback((path: string, nextName: string) => {
		setFiles((prev) =>
			prev.map((file) =>
				file.path === path ? { ...file, path: nextName } : file,
			),
		);
		setContent((prev) => {
			const next = { ...prev };
			next[nextName] = next[path] ?? "";
			delete next[path];
			return next;
		});
		setCurrentPath((prev) => (prev === path ? nextName : prev));
	}, []);

	const onDeleteFile = useCallback((path: string) => {
		setFiles((prev) => prev.filter((file) => file.path !== path));
		setContent((prev) => {
			const next = { ...prev };
			delete next[path];
			return next;
		});
		setCurrentPath((prev) => (prev === path ? null : prev));
	}, []);

	const onTogglePinnedFile = useCallback((path: string) => {
		setFiles((prev) =>
			prev.map((file) =>
				file.path === path ? { ...file, pinned: !file.pinned } : file,
			),
		);
	}, []);

	const editorMarkdown = activePath ? (content[activePath] ?? "") : "";
	const editorKey = activePath ?? "empty";
	const workspaceLabel = "Demo Workspace";

	const wrapperClassName = useMemo(() => `demo-shell theme-${theme}`, [theme]);

	// R25/QA4-a: a keyboard shortcut (Alt+T) toggles the theme without going
	// through the popup libraries' own "outside pointer press" dismiss logic
	// (base-ui's Menu/Select/Dialog all close on an outside *pointer* press,
	// which is standard, correct a11y behavior, not something this phase
	// changes) -- so this is how a popup can be kept open across a live
	// theme change for the R25 check. A real host would trigger this from
	// wherever ITS OWN theme control lives (a settings pane, an OS-level
	// preference listener, etc.) -- the point R25 verifies is that changing
	// the wrapper's CSS variables is a plain state update/re-render, with no
	// remount that would otherwise unmount an open popup.
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.altKey && event.key.toLowerCase() === "t") {
				event.preventDefault();
				setTheme((prev) => (prev === "mdly" ? "speechtodo" : "mdly"));
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	return (
		// R23/QA2-a/QA2-c: `demo-page-constrained` wraps the themed WRAPPER
		// ITSELF (the div below, which is also the PortalContainerProvider's
		// mount target) inside a bounded, scroll-clipped ancestor -- not just
		// some inner content -- so opening a popup near the constrained edge
		// proves popups still render fully visible even though an ancestor of
		// the mount target clips/scrolls (position:fixed popups escape an
		// ancestor's `overflow` unless that ancestor also introduces a new
		// containing block via transform/filter -- R28 keeps this wrapper and
		// everything around it free of those).
		<div className={constrained ? "demo-page demo-page-constrained" : "demo-page"}>
			<div ref={setWrapperEl} className={wrapperClassName}>
				<PortalContainerProvider container={wrapperEl}>
					<div className="demo-controls">
						<strong>@mdly/workspace-kit theming demo</strong>
						<button
							type="button"
							aria-pressed={theme === "speechtodo"}
							onClick={() =>
								setTheme((prev) => (prev === "mdly" ? "speechtodo" : "mdly"))
							}
						>
							Palette: {theme === "mdly" ? "mdly default" : "SpeechToDo style"}
						</button>
						<span style={{ opacity: 0.6 }}>
							(Alt+T also toggles -- doesn't dismiss an open popup)
						</span>
						<label>
							<input
								type="checkbox"
								checked={emptyMode}
								onChange={(event) => setEmptyMode(event.target.checked)}
							/>
							Empty / first-run state
						</label>
						<label>
							<input
								type="checkbox"
								checked={constrained}
								onChange={(event) => setConstrained(event.target.checked)}
							/>
							Constrain the wrapper in a scroll-clipped box
						</label>
					</div>
					<Toolbar
						currentPath={activePath}
						sidebarOpen={sidebarOpen}
						platformInset={false}
						onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
						leftSlot={
							<WorkspaceSwitcherMenu
								label={workspaceLabel}
								open={switcherOpen}
								onOpenChange={setSwitcherOpen}
							>
								<WorkspaceSwitcherMenu.Item selected>
									<span>{workspaceLabel}</span>
								</WorkspaceSwitcherMenu.Item>
								<WorkspaceSwitcherMenu.Separator />
								<WorkspaceSwitcherMenu.Item
									onClick={() => {
										/* demo-only: a real host would open another workspace */
									}}
								>
									<span>Second Workspace (demo only)</span>
								</WorkspaceSwitcherMenu.Item>
							</WorkspaceSwitcherMenu>
						}
						rightSlot={<NewNoteButton onClick={() => void onCreateFile()} />}
					/>
					<div className="demo-content">
						{sidebarOpen && (
							<Sidebar
								files={activeFiles}
								currentPath={activePath}
								sortMode={sortMode}
								onSortModeChange={setSortMode}
								onSelectFile={onSelectFile}
								onCreateFile={onCreateFile}
								onRenameFile={onRenameFile}
								onDeleteFile={onDeleteFile}
								onTogglePinnedFile={onTogglePinnedFile}
								onCollapse={() => setSidebarOpen(false)}
								emptyState={
									<div className="demo-empty-sidebar">
										No files yet -- create one with the toolbar's "+" button.
									</div>
								}
							/>
						)}
						<section style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
							{activePath ? (
								<EditorView
									key={editorKey}
									path={activePath}
									initialMarkdown={editorMarkdown}
									onLocalChange={(path, markdown) =>
										setContent((prev) => ({ ...prev, [path]: markdown }))
									}
									onSave={() => {
										/* demo-only: no real persistence */
									}}
									onOpenExternalLink={() => {
										/* demo-only: no-op, avoids navigating away from the demo */
									}}
									onOpenWikiLink={() => {
										/* demo-only: no wiki targets are configured */
									}}
								/>
							) : (
								<div className="demo-empty-editor">
									No file open -- select or create one in the sidebar.
								</div>
							)}
						</section>
					</div>
				</PortalContainerProvider>
			</div>
		</div>
	);
}
