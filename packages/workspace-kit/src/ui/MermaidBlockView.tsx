import {
	type NodeViewProps,
	NodeViewWrapper,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import { useEffect, useId, useRef, useState } from "react";
import { MermaidBlockExtension } from "../engine/index.js";
import { Button } from "../primitives/button";
import { Modal } from "../primitives/modal";

type PeleModule = typeof import("pele");

let pelePromise: Promise<PeleModule> | null = null;

// Lazy-load pele only when the first diagram actually renders, keeping editor
// startup lean for documents without diagrams.
function loadPele(): Promise<PeleModule> {
	if (!pelePromise) {
		pelePromise = import("pele");
	}
	return pelePromise;
}

export const MermaidBlockViewExtension = MermaidBlockExtension.extend({
	addNodeView() {
		return ReactNodeViewRenderer(MermaidBlockView);
	},
});

function MermaidBlockView({ node, updateAttributes }: NodeViewProps) {
	const raw = typeof node.attrs.raw === "string" ? node.attrs.raw : "";
	const diagramRef = useRef<HTMLDivElement>(null);
	const reactId = useId();
	const idPrefix = `mermaid-${reactId.replace(/[^a-zA-Z0-9-]/g, "")}-`;
	const [error, setError] = useState<string | null>(null);
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState(raw);

	useEffect(() => {
		const container = diagramRef.current;
		if (!container) return;
		if (raw.trim() === "") {
			container.innerHTML = "";
			setError(null);
			return;
		}

		let cancelled = false;
		void (async () => {
			try {
				const { render } = await loadPele();
				if (cancelled) return;
				// Colors come from `--pele-*` CSS variables (EditorView.css), so
				// theme switches restyle the SVG without re-rendering.
				const { svg } = render(raw, {
					idPrefix,
					maxWidth: container.clientWidth || undefined,
				});
				container.innerHTML = svg;
				setError(null);
			} catch (renderError) {
				if (cancelled) return;
				container.innerHTML = "";
				setError(
					renderError instanceof Error
						? renderError.message
						: "Failed to render diagram",
				);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [raw, idPrefix]);

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
						{/* Stays mounted through errors so a fixed source can render into it. */}
						<div
							ref={diagramRef}
							className="pm-mermaid-block-diagram"
							aria-hidden="true"
							hidden={error !== null}
						/>
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
						className="min-h-48 w-full resize-y rounded-sm border border-border bg-background p-2 font-mono text-xs text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
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
