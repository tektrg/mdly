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
const CONTENT_COUNT_DEBOUNCE_MS = 2_000;

export function FormattingStatusBar({
	editor,
	path,
	onOpenRevisionHistory,
}: {
	editor: Editor | null;
	path: string;
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
		let countUpdateTimer: ReturnType<typeof setTimeout> | undefined;

		// Content counts scan the whole document -- update them only when the
		// document actually changed, never on cursor movement alone.
		const updateCounts = () => {
			const text = editor.getText();
			const wordCount = countWords(text);
			const charCount = text.length;
			setPaletteState((previous) =>
				previous.wordCount === wordCount && previous.charCount === charCount
					? previous
					: { ...previous, wordCount, charCount },
			);
		};

		// Cursor formatting reads only selection-local state (stored marks),
		// so it is cheap enough to refresh on every selection event without
		// re-scanning the document.
		const updateCaret = () => {
			const { state } = editor;
			const next =
				!editor.isFocused || !state.selection.empty
					? { activeMarkNames: [] as string[], canEscapeBoundary: false }
					: getCaretFormattingState(state);
			setPaletteState((previous) =>
				previous.canEscapeBoundary === next.canEscapeBoundary &&
				sameMarkNames(previous.activeMarkNames, next.activeMarkNames)
					? previous
					: { ...previous, ...next },
			);
		};

		const scheduleCountUpdate = () => {
			if (countUpdateTimer !== undefined) clearTimeout(countUpdateTimer);
			countUpdateTimer = setTimeout(() => {
				countUpdateTimer = undefined;
				updateCounts();
			}, CONTENT_COUNT_DEBOUNCE_MS);
		};

		// A single keystroke fires both `selectionUpdate` and `transaction`;
		// keep caret feedback immediate while moving the full-document scan out
		// of the typing path and collapsing an edit burst into one recount.
		const onTransaction = (event?: {
			transaction?: { docChanged?: boolean };
		}) => {
			if (event?.transaction && event.transaction.docChanged === false) {
				updateCaret();
				return;
			}
			scheduleCountUpdate();
			updateCaret();
		};

		updateCounts();
		updateCaret();
		requestAnimationFrame(updateCaret);
		editor.on("selectionUpdate", updateCaret);
		editor.on("transaction", onTransaction);
		editor.on("focus", updateCaret);
		editor.on("blur", updateCaret);

		return () => {
			if (countUpdateTimer !== undefined) clearTimeout(countUpdateTimer);
			editor.off("selectionUpdate", updateCaret);
			editor.off("transaction", onTransaction);
			editor.off("focus", updateCaret);
			editor.off("blur", updateCaret);
		};
	}, [editor]);
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

function sameMarkNames(a: string[], b: string[]) {
	return a.length === b.length && a.every((name, index) => name === b[index]);
}
