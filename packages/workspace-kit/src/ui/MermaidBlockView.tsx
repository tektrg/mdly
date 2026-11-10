import { ContextMenu } from "@base-ui/react/context-menu";
import {
	type NodeViewProps,
	NodeViewWrapper,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import { lazy, Suspense, useState } from "react";
import MingcuteEdit2Line from "~icons/mingcute/edit-2-line";
import MingcuteFullscreenLine from "~icons/mingcute/fullscreen-line";
import { MermaidBlockExtension } from "../engine/index.js";
import { usePortalContainer } from "../lib/portalContainer";
import { Button } from "../primitives/button";
import { Modal } from "../primitives/modal";
import { MermaidViewer } from "./MermaidViewer";

// Lazy-load diagram-kit (and pele behind it) only when the first diagram
// actually renders, keeping editor startup lean for documents without diagrams.
const MermaidDiagram = lazy(() =>
	import("@tektrg/diagram-kit/react").then((module) => ({
		default: module.MermaidDiagram,
	})),
);

export const MermaidBlockViewExtension = MermaidBlockExtension.extend({
	addNodeView() {
		return ReactNodeViewRenderer(MermaidBlockView);
	},
});

function MermaidBlockView({ node, updateAttributes }: NodeViewProps) {
	const raw = typeof node.attrs.raw === "string" ? node.attrs.raw : "";
	const [error, setError] = useState<string | null>(null);
	const [isEditing, setIsEditing] = useState(false);
	const [isViewing, setIsViewing] = useState(false);
	const portalContainer = usePortalContainer();
	const [draft, setDraft] = useState(raw);

	const openEditor = () => {
		setDraft(raw);
		setIsEditing(true);
	};

	const saveDraft = () => {
		updateAttributes({ raw: draft });
		setIsEditing(false);
	};

	const isEmpty = raw.trim() === "";
	// Nothing (or nothing valid) to look at: a click goes straight to the source.
	const canView = !isEmpty && error === null;

	const editFromViewer = () => {
		setIsViewing(false);
		openEditor();
	};

	return (
		<NodeViewWrapper className="pm-mermaid-block" as="div">
			<ContextMenu.Root>
				<ContextMenu.Trigger render={<div contentEditable={false} />}>
					<button
						type="button"
						className="pm-mermaid-block-surface"
						contentEditable={false}
						aria-label={canView ? "View diagram full screen" : "Edit diagram"}
						title={
							canView
								? "Click to view full screen · right-click to edit"
								: "Click to edit diagram"
						}
						onMouseDown={(event) => event.preventDefault()}
						onClick={canView ? () => setIsViewing(true) : openEditor}
					>
						{isEmpty ? (
							<span className="pm-mermaid-block-placeholder">
								Empty diagram — click to edit
							</span>
						) : (
							<>
								{error && (
									<span className="pm-mermaid-block-error">
										<span className="pm-mermaid-block-error-title">
											Diagram error: {error}
										</span>
										<code className="pm-mermaid-block-source">{raw}</code>
									</span>
								)}
								{/* diagram-kit keeps its SVG container mounted through errors, so a
							    fixed source renders into it; its own error box is hidden by CSS
							    in favour of the one above. */}
								<span aria-hidden="true" style={{ display: "contents" }}>
									<Suspense fallback={null}>
										<MermaidDiagram
											source={raw}
											className="pm-mermaid-block-diagram"
											onError={(diagramError) =>
												setError(diagramError?.message ?? null)
											}
										/>
									</Suspense>
								</span>
							</>
						)}
					</button>
				</ContextMenu.Trigger>
				<ContextMenu.Portal container={portalContainer}>
					<ContextMenu.Positioner className="z-50">
						<ContextMenu.Popup className="min-w-44 origin-(--transform-origin) rounded-[18px] bg-popover p-1 text-popover-foreground shadow-overlay outline-hidden">
							<ContextMenu.Item
								className="flex w-full cursor-pointer items-center gap-2 rounded-mdly-control px-2 py-1.5 text-start text-xs outline-hidden select-none data-highlighted:bg-accent"
								onClick={openEditor}
							>
								<MingcuteEdit2Line className="size-3.5" aria-hidden="true" />
								Edit code
							</ContextMenu.Item>
							{canView ? (
								<ContextMenu.Item
									className="flex w-full cursor-pointer items-center gap-2 rounded-mdly-control px-2 py-1.5 text-start text-xs outline-hidden select-none data-highlighted:bg-accent"
									onClick={() => setIsViewing(true)}
								>
									<MingcuteFullscreenLine
										className="size-3.5"
										aria-hidden="true"
									/>
									View full screen
								</ContextMenu.Item>
							) : null}
						</ContextMenu.Popup>
					</ContextMenu.Positioner>
				</ContextMenu.Portal>
			</ContextMenu.Root>

			<MermaidViewer
				open={isViewing}
				onOpenChange={setIsViewing}
				source={raw}
				onEdit={editFromViewer}
			/>

			<Modal
				open={isEditing}
				onOpenChange={setIsEditing}
				title="Mermaid diagram"
				description="Edit the diagram source. Rendered on save."
				className="max-w-2xl"
			>
				<div className="flex flex-col gap-3">
					<textarea
						className="min-h-48 w-full resize-y rounded-mdly-control bg-background p-2 font-mono text-xs text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
						value={draft}
						spellCheck={false}
						// biome-ignore lint/a11y/noAutofocus: focus the editor when the modal opens
						autoFocus
						onChange={(event) => setDraft(event.target.value)}
					/>
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setIsEditing(false)}
						>
							Cancel
						</Button>
						<Button type="button" size="sm" onClick={saveDraft}>
							Save
						</Button>
					</div>
				</div>
			</Modal>
		</NodeViewWrapper>
	);
}
