import {
	type NodeViewProps,
	NodeViewWrapper,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import { lazy, Suspense, useState } from "react";
import { MermaidBlockExtension } from "../engine/index.js";
import { Button } from "../primitives/button";
import { Modal } from "../primitives/modal";

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

	return (
		<NodeViewWrapper className="pm-mermaid-block" as="div">
			<button
				type="button"
				className="pm-mermaid-block-surface"
				contentEditable={false}
				aria-label="Edit diagram"
				title="Click to edit diagram"
				onMouseDown={(event) => event.preventDefault()}
				onClick={openEditor}
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
