import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useEffect, useMemo, useState } from "react";
import MingcuteMessage3Line from "~icons/mingcute/message-3-line";
import type { ResolvedThread } from "../comments/index.js";
import "./TableOfContents.css";

const SCROLL_CONTEXT_BLOCK_OFFSET = 96;

type TableOfContentsHeading = {
	id: string;
	level: number;
	pos: number;
	title: string;
	progress: number;
};

type TableOfContentsProps = {
	editor: Editor | null;
	scrollContainer: HTMLDivElement | null;
	/** Opt-in (same convention as `EditorView`'s other opt-in props): when
	 * provided, each heading whose section contains a non-orphaned comment
	 * gets a small indicator. Omit to render exactly as before. */
	threads?: ResolvedThread[];
};

export function TableOfContents({
	editor,
	scrollContainer,
	threads,
}: TableOfContentsProps) {
	const [headings, setHeadings] = useState<TableOfContentsHeading[]>([]);
	const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
	const [isExpanded, setIsExpanded] = useState(false);

	useEffect(() => {
		if (!editor) {
			setHeadings([]);
			return;
		}

		const updateHeadings = () => {
			setHeadings(collectTableOfContentsHeadings(editor.state.doc));
		};
		const updateHeadingsAfterDocChange: Parameters<
			typeof editor.on<"transaction">
		>[1] = ({ transaction }) => {
			if (transaction.docChanged) updateHeadings();
		};

		updateHeadings();
		editor.on("transaction", updateHeadingsAfterDocChange);
		return () => {
			editor.off("transaction", updateHeadingsAfterDocChange);
		};
	}, [editor]);

	useEffect(() => {
		if (!editor || !scrollContainer || headings.length === 0) {
			setActiveHeadingId(null);
			return;
		}

		const updateActiveHeading = () => {
			const viewportTop = scrollContainer.getBoundingClientRect().top;
			let active = headings[0];

			for (const heading of headings) {
				const headingTop = nodeTopForPosition(editor, heading.pos);
				if (headingTop === null) continue;
				if (headingTop - viewportTop > SCROLL_CONTEXT_BLOCK_OFFSET) break;
				active = heading;
			}

			setActiveHeadingId(active.id);
		};

		updateActiveHeading();
		scrollContainer.addEventListener("scroll", updateActiveHeading, {
			passive: true,
		});
		window.addEventListener("resize", updateActiveHeading);
		return () => {
			scrollContainer.removeEventListener("scroll", updateActiveHeading);
			window.removeEventListener("resize", updateActiveHeading);
		};
	}, [editor, headings, scrollContainer]);

	// Section = from this heading's position up to (not including) the next
	// heading's position; `headings` is already in document order from
	// `collectTableOfContentsHeadings`'s `doc.descendants` walk, so "last
	// heading whose pos <= range.from" is equivalent to an interval match.
	// Maps heading id -> whether every comment in that section is resolved,
	// mirroring the resolved/unresolved dimming `CommentGutter` and
	// `CommentParagraphMarker` already show -- a heading with any open
	// comment reads as "needs attention", not just "has comments".
	const headingCommentState = useMemo(() => {
		if (!threads || threads.length === 0 || headings.length === 0) {
			return new Map<string, boolean>();
		}
		const state = new Map<string, boolean>();
		for (const thread of threads) {
			if (thread.anchorResolution.status === "orphaned") continue;
			const range = thread.anchorResolution.range;
			if (!range) continue;
			let matched: TableOfContentsHeading | undefined;
			for (const heading of headings) {
				if (heading.pos > range.from) break;
				matched = heading;
			}
			if (!matched) continue;
			const isResolved = thread.state === "resolved";
			const current = state.get(matched.id);
			state.set(
				matched.id,
				current === undefined ? isResolved : current && isResolved,
			);
		}
		return state;
	}, [threads, headings]);

	if (!editor || headings.length === 0) return null;

	const scrollToHeading = (heading: TableOfContentsHeading) => {
		const node = nodeElementForPosition(editor, heading.pos);
		if (!node) return;
		node.scrollIntoView({ block: "start", behavior: "smooth" });
	};

	return (
		<nav
			className="editorTableOfContents"
			aria-label="Table of contents"
			data-expanded={isExpanded}
			onMouseEnter={() => setIsExpanded(true)}
			onMouseLeave={() => setIsExpanded(false)}
			onFocus={() => setIsExpanded(true)}
			onBlur={(event) => {
				if (
					event.relatedTarget instanceof Node &&
					event.currentTarget.contains(event.relatedTarget)
				) {
					return;
				}
				setIsExpanded(false);
			}}
		>
			<button
				type="button"
				className="editorTableOfContentsTrigger"
				aria-label="Show table of contents"
				aria-expanded={isExpanded}
				onClick={() => setIsExpanded(true)}
			>
				<span className="editorTableOfContentsRail" aria-hidden="true">
					{headings.map((heading) => (
						<span
							key={heading.id}
							className="editorTableOfContentsDash"
							data-active={heading.id === activeHeadingId}
							data-level={heading.level}
							style={{
								insetBlockStart: `${heading.progress * 100}%`,
							}}
						/>
					))}
				</span>
			</button>
			<div
				className="editorTableOfContentsPanel"
				aria-hidden={!isExpanded}
				inert={isExpanded ? undefined : true}
			>
				<ol className="editorTableOfContentsList">
					{headings.map((heading) => (
						<li key={heading.id}>
							<button
								type="button"
								className="editorTableOfContentsItem"
								data-active={heading.id === activeHeadingId}
								data-level={heading.level}
								tabIndex={isExpanded ? 0 : -1}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => scrollToHeading(heading)}
							>
								<span className="editorTableOfContentsItemLabel">
									{heading.title}
								</span>
								{headingCommentState.has(heading.id) ? (
									<MingcuteMessage3Line
										className="editorTableOfContentsCommentBadge"
										aria-hidden="true"
										data-comment-indicator
										data-resolved={headingCommentState.get(heading.id)}
									/>
								) : null}
							</button>
						</li>
					))}
				</ol>
			</div>
		</nav>
	);
}

export function collectTableOfContentsHeadings(
	doc: ProseMirrorNode,
): TableOfContentsHeading[] {
	const headings: TableOfContentsHeading[] = [];
	const docSize = Math.max(doc.content.size, 1);

	doc.descendants((node, pos) => {
		if (node.type.name !== "heading") return;

		const level = Number(node.attrs.level);
		const boundedLevel = Number.isFinite(level) ? clamp(level, 1, 6) : 1;
		const title = node.textContent.trim() || `Heading ${boundedLevel}`;

		headings.push({
			id: `heading-${pos}`,
			level: boundedLevel,
			pos,
			title,
			progress: clamp(pos / docSize, 0, 1),
		});
	});

	return headings;
}

function nodeTopForPosition(editor: Editor, pos: number): number | null {
	return (
		nodeElementForPosition(editor, pos)?.getBoundingClientRect().top ?? null
	);
}

function nodeElementForPosition(
	editor: Editor,
	pos: number,
): HTMLElement | null {
	const node = editor.view.nodeDOM(pos);
	if (!(node instanceof HTMLElement)) return null;
	return node;
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}
