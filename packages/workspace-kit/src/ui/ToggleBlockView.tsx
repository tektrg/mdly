import {
	NodeViewContent,
	type NodeViewProps,
	NodeViewWrapper,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import { useState } from "react";
import MingcuteRightLine from "~icons/mingcute/right-line";
import { ToggleExtension } from "../engine/index.js";
import { cn } from "../lib/utils";

export const ToggleBlockViewExtension = ToggleExtension.extend({
	addNodeView() {
		return ReactNodeViewRenderer(ToggleBlockView);
	},
});

// Expand/collapse is local UI state only — it seeds from node.attrs.open
// (the source `<details open>`, if any) but never writes back to it, so
// toggling never dirties the document. See ToggleBlock.ts.
function ToggleBlockView({ node }: NodeViewProps) {
	const [isOpen, setIsOpen] = useState(() => Boolean(node.attrs.open));

	return (
		<NodeViewWrapper className="pm-toggle" data-open={isOpen} as="div">
			<button
				type="button"
				className="pm-toggle-chevron"
				contentEditable={false}
				aria-label={isOpen ? "Collapse toggle" : "Expand toggle"}
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => setIsOpen((open) => !open)}
			>
				<MingcuteRightLine
					aria-hidden="true"
					className={cn(
						"size-3.5 shrink-0 transition-transform",
						isOpen && "rotate-90",
					)}
				/>
			</button>
			<NodeViewContent className="pm-toggle-content" />
		</NodeViewWrapper>
	);
}
