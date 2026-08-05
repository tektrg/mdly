import { MermaidBlockExtension } from "../engine/index.js";
import {
	type NodeViewProps,
	NodeViewWrapper,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../primitives/button";
import { Modal } from "../primitives/modal";

type MermaidModule = typeof import("mermaid")["default"];

let mermaidPromise: Promise<MermaidModule> | null = null;

// Lazy-load mermaid (~500KB) only when the first diagram actually renders,
// keeping editor startup lean for documents without diagrams.
function loadMermaid(): Promise<MermaidModule> {
	if (!mermaidPromise) {
		mermaidPromise = import("mermaid").then((mod) => mod.default);
	}
	return mermaidPromise;
}

// The app's theme toggle sets/removes `dark` on the document root; track it so
// diagrams re-render in the matching mermaid theme.
function useIsDarkTheme(): boolean {
	const [isDark, setIsDark] = useState(
		() =>
			typeof document !== "undefined" &&
			document.documentElement.classList.contains("dark"),
	);

	useEffect(() => {
		const root = document.documentElement;
		const update = () => setIsDark(root.classList.contains("dark"));
		update();
		const observer = new MutationObserver(update);
		observer.observe(root, { attributes: true, attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, []);

	return isDark;
}

export const MermaidBlockViewExtension = MermaidBlockExtension.extend({
	addNodeView() {
		return ReactNodeViewRenderer(MermaidBlockView);
	},
});

function MermaidBlockView({ node, updateAttributes }: NodeViewProps) {
	const raw = typeof node.attrs.raw === "string" ? node.attrs.raw : "";
	const isDark = useIsDarkTheme();
	const diagramRef = useRef<HTMLDivElement>(null);
	const reactId = useId();
	const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9-]/g, "")}`;
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
				const mermaid = await loadMermaid();
				mermaid.initialize({
					startOnLoad: false,
					securityLevel: "strict",
					theme: isDark ? "dark" : "default",
				});
				const { svg } = await mermaid.render(renderId, raw);
				if (cancelled) return;
				container.innerHTML = svg;
				setError(null);
			} catch (renderError) {
				// On failure mermaid leaves its offscreen measurement container
				// (`d<id>`) attached to <body>; remove it so invalid edits don't
				// leak orphan error graphics into the document.
				document.getElementById(`d${renderId}`)?.remove();
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
	}, [raw, isDark, renderId]);

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
				) : error ? (
					<span className="pm-mermaid-block-error">
						<span className="pm-mermaid-block-error-title">
							Diagram error: {error}
						</span>
						<code className="pm-mermaid-block-source">{raw}</code>
					</span>
				) : (
					<div
						ref={diagramRef}
						className="pm-mermaid-block-diagram"
						aria-hidden="true"
					/>
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
