import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState } from "react";
import MingcuteMessage3Line from "~icons/mingcute/message-3-line";
import type { ResolvedThread } from "../comments/index.js";
import "./TableOfContents.css";
import { useTocHeadings } from "./useTocHeadings.js";

export {
	collectTableOfContentsHeadings,
	stabilizeHeadingIds,
	type TableOfContentsHeading,
} from "./useTocHeadings.js";

/** Hovering the rail waits this long before opening the list, so passing the mouse over it doesn't flash the popup. */
const HOVER_OPEN_DELAY_MS = 300;

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
	const { headings, activeHeadingId, headingCommentState, scrollToHeading } =
		useTocHeadings(editor, scrollContainer, threads);
	const [isExpanded, setIsExpanded] = useState(false);
	const hoverTimer = useRef<number | undefined>(undefined);
	useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

	if (!editor || headings.length === 0) return null;

	return (
		<nav
			className="editorTableOfContents"
			aria-label="Table of contents"
			data-expanded={isExpanded}
			onMouseEnter={() => {
				window.clearTimeout(hoverTimer.current);
				hoverTimer.current = window.setTimeout(
					() => setIsExpanded(true),
					HOVER_OPEN_DELAY_MS,
				);
			}}
			onMouseLeave={() => {
				window.clearTimeout(hoverTimer.current);
				setIsExpanded(false);
			}}
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
