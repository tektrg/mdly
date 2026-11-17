/**
 * Review controls for inline suggestions: count, previous/next, accept/reject
 * the active change, accept/reject all. Shown only while suggestions exist.
 */
import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import {
	getSuggestions,
	type SuggestionChange,
	suggestionKey,
} from "../editor/SuggestionExtension";

function useSuggestions(editor: Editor | null) {
	const [state, setState] = useState<{
		changes: SuggestionChange[];
		activeId: string | null;
	}>({ changes: [], activeId: null });
	useEffect(() => {
		if (!editor) return;
		const update = () => {
			const value = suggestionKey.getState(editor.state);
			setState({
				changes: getSuggestions(editor.state),
				activeId: value?.activeId ?? null,
			});
		};
		update();
		editor.on("transaction", update);
		return () => {
			editor.off("transaction", update);
		};
	}, [editor]);
	return state;
}

const btn = "rounded px-1.5 py-0.5 hover:bg-muted";

export function SuggestionReviewBar({ editor }: { editor: Editor | null }) {
	const { changes, activeId } = useSuggestions(editor);
	if (!editor || changes.length === 0) return null;
	const index = Math.max(
		0,
		changes.findIndex((c) => c.id === activeId),
	);
	const active = changes[index];
	return (
		<div
			className="fixed z-40 flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-xs shadow-md"
			style={{ insetBlockStart: 56, insetInlineEnd: 16 }}
			data-testid="suggestion-review-bar"
		>
			<span className="px-1 text-muted-foreground">
				{index + 1}/{changes.length}{" "}
				{active?.source === "agent" ? "agent" : "tool"} change
				{changes.length === 1 ? "" : "s"}
			</span>
			<button
				type="button"
				className={btn}
				title="Previous change (⌘⌥[)"
				onClick={() => editor.commands.nextSuggestion(-1)}
			>
				↑
			</button>
			<button
				type="button"
				className={btn}
				title="Next change (⌘⌥])"
				onClick={() => editor.commands.nextSuggestion(1)}
			>
				↓
			</button>
			<button
				type="button"
				className={`${btn} text-emerald-600`}
				title="Accept change (⌘⌥↩)"
				onClick={() => editor.commands.acceptSuggestion(active?.id)}
			>
				Accept
			</button>
			<button
				type="button"
				className={`${btn} text-red-600`}
				title="Reject change (⌘⌥⌫)"
				onClick={() => editor.commands.rejectSuggestion(active?.id)}
			>
				Reject
			</button>
			<span className="mx-1 h-4 border-s border-border" />
			<button
				type="button"
				className={btn}
				onClick={() => editor.commands.acceptAllSuggestions()}
			>
				Accept all
			</button>
			<button
				type="button"
				className={btn}
				onClick={() => editor.commands.rejectAllSuggestions()}
			>
				Reject all
			</button>
		</div>
	);
}
