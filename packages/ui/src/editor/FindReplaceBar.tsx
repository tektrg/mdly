import type { Editor } from "@tiptap/core";
import {
	type WheelEvent as ReactWheelEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import MingcuteCheckLine from "~icons/mingcute/check-line";
import MingcuteCloseLine from "~icons/mingcute/close-line";
import MingcuteSearchLine from "~icons/mingcute/search-line";
import { Button } from "../primitives/button";
import { Input } from "../primitives/input";
import { findReplaceHighlightKey } from "./FindReplaceExtension";
import {
	type FindOptions,
	findDocumentTextMatches,
	findStringMatches,
	matchIndexAfterPosition,
	replaceAllEditorMatches,
	replaceAllStringMatches,
	replaceEditorMatch,
	replaceStringMatch,
	type StringMatch,
	scrollEditorMatchIntoView,
	type TextMatch,
} from "./findReplace";

type FrontMatterSearch = {
	text: string;
	onReplace: (nextFrontMatter: string) => void;
};

export type CombinedMatch =
	| { scope: "body"; match: TextMatch }
	| { scope: "frontMatter"; match: StringMatch };

export function combineFindReplaceMatches(
	bodyMatches: TextMatch[],
	frontMatterMatches: StringMatch[],
): CombinedMatch[] {
	return [
		...frontMatterMatches.map(
			(match): CombinedMatch => ({
				scope: "frontMatter",
				match,
			}),
		),
		...bodyMatches.map((match): CombinedMatch => ({ scope: "body", match })),
	];
}

export function FindReplaceBar({
	editor,
	open,
	frontMatter,
	onOpenChange,
	onFrontMatterActiveChange,
}: {
	editor: Editor | null;
	open: boolean;
	frontMatter: FrontMatterSearch;
	onOpenChange: (open: boolean) => void;
	onFrontMatterActiveChange?: (active: boolean) => void;
}) {
	const queryInputRef = useRef<HTMLInputElement>(null);
	const lastScrolledBodyMatchKeyRef = useRef<string | null>(null);
	const [query, setQuery] = useState("");
	const [replacement, setReplacement] = useState("");
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const [editorRevision, setEditorRevision] = useState(0);
	const options: FindOptions = useMemo(
		() => ({ caseSensitive }),
		[caseSensitive],
	);
	const bodyMatches = useMemo(() => {
		void editorRevision;
		return editor
			? findDocumentTextMatches(editor.state.doc, query, options)
			: [];
	}, [editor, editorRevision, query, options]);
	const frontMatterMatches = useMemo(
		() => findStringMatches(frontMatter.text, query, options),
		[frontMatter.text, query, options],
	);
	const matches = useMemo(
		() => combineFindReplaceMatches(bodyMatches, frontMatterMatches),
		[bodyMatches, frontMatterMatches],
	);
	const totalMatches = matches.length;
	const activeMatch =
		totalMatches === 0 ? null : matches[clampIndex(activeIndex, totalMatches)];
	const activeBodyIndex =
		activeMatch?.scope === "body" ? bodyMatches.indexOf(activeMatch.match) : -1;

	useEffect(() => {
		if (!editor) return;
		const updateRevision = () => setEditorRevision((revision) => revision + 1);
		editor.on("transaction", updateRevision);
		return () => {
			editor.off("transaction", updateRevision);
		};
	}, [editor]);

	useEffect(() => {
		if (!open) return;
		const selected = selectedEditorText(editor);
		if (selected) {
			setQuery(selected);
			setActiveIndex(0);
		}
		requestAnimationFrame(() => {
			queryInputRef.current?.focus();
			queryInputRef.current?.select();
		});
	}, [editor, open]);

	useEffect(() => {
		if (!editor) return;
		const tr = editor.state.tr.setMeta(
			findReplaceHighlightKey,
			open && bodyMatches.length > 0
				? { matches: bodyMatches, activeIndex: activeBodyIndex }
				: null,
		);
		editor.view.dispatch(tr);
	}, [activeBodyIndex, bodyMatches, editor, open]);

	useEffect(() => {
		if (activeIndex >= totalMatches) {
			setActiveIndex(Math.max(totalMatches - 1, 0));
		}
	}, [activeIndex, totalMatches]);

	useEffect(() => {
		if (!open) {
			lastScrolledBodyMatchKeyRef.current = null;
			return;
		}
		if (!editor || !shouldScrollActiveEditorMatch(open, activeMatch)) {
			lastScrolledBodyMatchKeyRef.current = null;
			return;
		}
		const matchKey = bodyMatchKey(activeMatch.match);
		if (lastScrolledBodyMatchKeyRef.current === matchKey) return;
		lastScrolledBodyMatchKeyRef.current = matchKey;
		scrollEditorMatchIntoView(editor, activeMatch.match);
	}, [activeMatch, editor, open]);

	useEffect(() => {
		const active = open && activeMatch?.scope === "frontMatter";
		onFrontMatterActiveChange?.(active);
		return () => onFrontMatterActiveChange?.(false);
	}, [activeMatch, onFrontMatterActiveChange, open]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (!open) return;
			if (event.key === "Escape") {
				event.preventDefault();
				onOpenChange(false);
				focusEditorAfterFindClose(editor);
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, [editor, onOpenChange, open]);

	if (!open) return null;

	const goTo = (direction: 1 | -1) => {
		if (totalMatches === 0) return;
		const currentIndex = clampIndex(activeIndex, totalMatches);
		const nextIndex = clampIndex(
			currentIndex + direction + totalMatches,
			totalMatches,
		);
		if (nextIndex === currentIndex) {
			scrollCurrentBodyMatchIntoView(editor, matches[nextIndex]);
			return;
		}
		lastScrolledBodyMatchKeyRef.current = null;
		setActiveIndex(nextIndex);
	};

	const replaceCurrent = () => {
		if (!editor || !activeMatch) return;
		if (activeMatch.scope === "frontMatter") {
			frontMatter.onReplace(
				replaceStringMatch(frontMatter.text, activeMatch.match, replacement),
			);
			setActiveIndex((current) => Math.max(current - 1, 0));
			return;
		}
		replaceEditorMatch(editor, activeMatch.match, replacement);
	};

	const replaceAll = () => {
		if (!editor || totalMatches === 0) return;
		const confirmed = window.confirm(
			`Replace ${totalMatches} match${totalMatches === 1 ? "" : "es"} in this file? This can change document text and front matter.`,
		);
		if (!confirmed) return;
		if (frontMatterMatches.length > 0) {
			frontMatter.onReplace(
				replaceAllStringMatches(
					frontMatter.text,
					frontMatterMatches,
					replacement,
				),
			);
		}
		replaceAllEditorMatches(editor, bodyMatches, replacement);
		setActiveIndex(0);
	};

	return (
		<search
			className="findReplaceBar"
			aria-label="Find and replace"
			onWheel={handleFindBarWheel}
		>
			<div className="flex min-w-0 flex-1 items-center gap-1.5">
				<MingcuteSearchLine className="size-3.5 shrink-0 text-muted-foreground" />
				<Input
					ref={queryInputRef}
					value={query}
					placeholder="Find"
					className="h-7 min-w-28"
					onChange={(event) => {
						setQuery(event.target.value);
						setActiveIndex(
							editor
								? matchIndexAfterPosition(
										findDocumentTextMatches(
											editor.state.doc,
											event.target.value,
											options,
										),
										editor.state.selection.from,
									)
								: 0,
						);
					}}
					onKeyDown={(event) => {
						if (event.key !== "Enter") return;
						event.preventDefault();
						goTo(event.shiftKey ? -1 : 1);
					}}
				/>
				<Input
					value={replacement}
					placeholder="Replace"
					className="h-7 min-w-28"
					onChange={(event) => setReplacement(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter") return;
						event.preventDefault();
						replaceCurrent();
					}}
				/>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<span className="min-w-14 text-right text-[11px] text-muted-foreground">
					{query.length === 0
						? "0/0"
						: `${totalMatches === 0 ? 0 : clampIndex(activeIndex, totalMatches) + 1}/${totalMatches}`}
				</span>
				{activeMatch?.scope === "frontMatter" ? (
					<span className="rounded-sm bg-muted px-1.5 py-1 text-[10px] text-muted-foreground">
						properties
					</span>
				) : null}
				<Button
					type="button"
					variant={caseSensitive ? "secondary" : "ghost"}
					size="xs"
					title="Match case"
					aria-pressed={caseSensitive}
					onClick={() => setCaseSensitive((value) => !value)}
				>
					Aa
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="xs"
					disabled={totalMatches === 0}
					onClick={() => goTo(-1)}
				>
					Prev
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="xs"
					disabled={totalMatches === 0}
					onClick={() => goTo(1)}
				>
					Next
				</Button>
				<Button
					type="button"
					variant="secondary"
					size="xs"
					disabled={totalMatches === 0}
					onClick={replaceCurrent}
				>
					Replace
				</Button>
				<Button
					type="button"
					variant="secondary"
					size="xs"
					disabled={totalMatches === 0}
					onClick={replaceAll}
				>
					<MingcuteCheckLine data-icon="inline-start" className="size-3" />
					All
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label="Close find and replace"
					title="Close"
					onClick={() => {
						onOpenChange(false);
						focusEditorAfterFindClose(editor);
					}}
				>
					<MingcuteCloseLine className="size-3" />
				</Button>
			</div>
		</search>
	);
}

export function shouldScrollActiveEditorMatch(
	open: boolean,
	activeMatch: CombinedMatch | null,
): activeMatch is Extract<CombinedMatch, { scope: "body" }> {
	return open && activeMatch?.scope === "body";
}

function bodyMatchKey(match: TextMatch) {
	return `${match.from}:${match.to}:${match.text}`;
}

function scrollCurrentBodyMatchIntoView(
	editor: Editor | null,
	activeMatch: CombinedMatch | undefined,
) {
	if (!editor || activeMatch?.scope !== "body") return;
	scrollEditorMatchIntoView(editor, activeMatch.match);
}

export function focusEditorAfterFindClose(editor: Editor | null) {
	editor?.commands.focus(undefined, { scrollIntoView: false });
}

function handleFindBarWheel(event: ReactWheelEvent<HTMLElement>) {
	scrollEditorViewportFromFindBarWheel(event.currentTarget, {
		deltaX: event.deltaX,
		deltaY: event.deltaY,
		preventDefault: () => event.preventDefault(),
	});
}

export function scrollEditorViewportFromFindBarWheel(
	findBar: HTMLElement,
	event: {
		deltaX: number;
		deltaY: number;
		preventDefault: () => void;
	},
) {
	const viewport = findEditorViewportForFindBar(findBar);
	if (!viewport) return;
	if (event.deltaX === 0 && event.deltaY === 0) return;

	event.preventDefault();
	viewport.scrollBy({
		left: event.deltaX,
		top: event.deltaY,
		behavior: "auto",
	});
}

function findEditorViewportForFindBar(findBar: HTMLElement) {
	const editorRoot = findBar.closest("[data-hubble-editor]");
	return editorRoot?.querySelector<HTMLElement>(".editorViewport") ?? null;
}

function clampIndex(index: number, total: number) {
	if (total <= 0) return 0;
	return ((index % total) + total) % total;
}

function selectedEditorText(editor: Editor | null) {
	if (!editor) return "";
	const { from, to } = editor.state.selection;
	if (from === to) return "";
	const text = editor.state.doc.textBetween(from, to, "\n");
	return text.includes("\n") ? "" : text;
}
