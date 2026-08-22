import type { Editor } from "@tiptap/core";
import { useEffect, useState } from "react";
import MingcuteBoldLine from "~icons/mingcute/bold-line";
import MingcuteHistoryLine from "~icons/mingcute/history-line";
import MingcuteItalicLine from "~icons/mingcute/italic-line";
import MingcuteLinkLine from "~icons/mingcute/link-line";
import MingcuteStrikethroughLine from "~icons/mingcute/strikethrough-line";
import { getCaretFormattingState } from "../engine/index.js";
import { fileNameFromPath } from "../lib/filePath";
import { Button } from "../primitives/button";

type CountMode = "words" | "chars";

type PaletteState = {
	wordCount: number;
	charCount: number;
	activeMarkNames: string[];
	canEscapeBoundary: boolean;
};

const floatingChipClass =
	"border border-border/50 bg-background/78 text-muted-foreground shadow-[var(--shadow-chip)] backdrop-blur-md";

export function FormattingStatusBar({
	editor,
	path,
	scrollContainer,
	onOpenRevisionHistory,
}: {
	editor: Editor | null;
	path: string;
	scrollContainer: HTMLDivElement | null;
	/** Opt-in (see `EditorViewProps.onOpenRevisionHistory`); omit to render no history affordance. */
	onOpenRevisionHistory?: (path: string) => void;
}) {
	const [countMode, setCountMode] = useState<CountMode>("words");
	const [paletteState, setPaletteState] = useState<PaletteState>({
		wordCount: 0,
		charCount: 0,
		activeMarkNames: [],
		canEscapeBoundary: false,
	});

	useEffect(() => {
		if (!editor) return;
		const resolvedScrollContainer =
			scrollContainer ??
			(editor.view.dom.closest(".editorViewport") as HTMLDivElement | null) ??
			null;

		const update = () => {
			const text = editor.getText();
			const wordCount = countWords(text);
			const charCount = text.length;
			const { state } = editor;
			if (!editor.isFocused || !state.selection.empty) {
				setPaletteState({
					wordCount,
					charCount,
					activeMarkNames: [],
					canEscapeBoundary: false,
				});
				return;
			}

			const caretState = getCaretFormattingState(state);
			setPaletteState({
				wordCount,
				charCount,
				activeMarkNames: caretState.activeMarkNames,
				canEscapeBoundary: caretState.canEscapeBoundary,
			});
		};

		update();
		requestAnimationFrame(update);
		editor.on("selectionUpdate", update);
		editor.on("transaction", update);
		editor.on("focus", update);
		editor.on("blur", update);
		resolvedScrollContainer?.addEventListener("scroll", update, {
			passive: true,
		});
		window.addEventListener("scroll", update, true);
		window.addEventListener("resize", update);

		return () => {
			editor.off("selectionUpdate", update);
			editor.off("transaction", update);
			editor.off("focus", update);
			editor.off("blur", update);
			resolvedScrollContainer?.removeEventListener("scroll", update);
			window.removeEventListener("scroll", update, true);
			window.removeEventListener("resize", update);
		};
	}, [editor, scrollContainer]);
	if (!editor) return null;
	const fileName = fileNameFromPath(path);
	const countLabel =
		countMode === "words"
			? `${paletteState.wordCount} words`
			: `${paletteState.charCount} characters`;
	const hasActiveFormatting = paletteState.activeMarkNames.length > 0;

	return (
		<div className="pointer-events-none absolute inset-0 z-[4] text-[12px]">
			<div className="absolute start-3 top-3 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5">
				<span
					className={`${floatingChipClass} max-w-[min(34rem,100%)] truncate rounded-full px-3 py-1`}
					title={fileName}
				>
					{fileName}
				</span>
				{onOpenRevisionHistory && (
					<Button
						variant="ghost"
						size="icon-xs"
						data-revision-history-trigger
						className={`${floatingChipClass} pointer-events-auto rounded-full hover:bg-accent`}
						aria-label="View revision history"
						title="View revision history"
						onClick={() => onOpenRevisionHistory(path)}
					>
						<MingcuteHistoryLine className="size-3.5" />
					</Button>
				)}
			</div>
			<div className="absolute bottom-3 start-3 flex items-center gap-2">
				<Button
					variant="ghost"
					size="xs"
					className={`${floatingChipClass} pointer-events-auto h-7 rounded-full px-3 hover:bg-accent`}
					title={
						countMode === "words" ? "Show character count" : "Show word count"
					}
					onClick={() =>
						setCountMode((m) => (m === "words" ? "chars" : "words"))
					}
				>
					{countLabel}
				</Button>
				{paletteState.canEscapeBoundary && (
					<span
						className={`${floatingChipClass} inline-flex h-6 items-center rounded-full px-2 text-[11px] leading-none`}
					>
						esc
					</span>
				)}
			</div>
			{hasActiveFormatting ? (
				<div
					className={`${floatingChipClass} absolute bottom-3 end-3 flex h-7 items-center gap-2 rounded-full px-2`}
				>
					{paletteState.activeMarkNames.includes("bold") && (
						<MingcuteBoldLine className="size-4" />
					)}
					{paletteState.activeMarkNames.includes("italic") && (
						<MingcuteItalicLine className="size-4" />
					)}
					{paletteState.activeMarkNames.includes("strike") && (
						<MingcuteStrikethroughLine className="size-4" />
					)}
					{paletteState.activeMarkNames.includes("link") && (
						<MingcuteLinkLine className="size-4" />
					)}
				</div>
			) : null}
		</div>
	);
}

function countWords(text: string) {
	const trimmed = text.trim();
	if (trimmed.length === 0) return 0;
	return trimmed.split(/\s+/).length;
}
