import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useEffect, useMemo, useRef, useState } from "react";
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
	const measuredOnce = useRef(false);

	useEffect(() => {
		measuredOnce.current = false;
		if (!editor) {
			setHeadings([]);
			return;
		}

		const updateHeadings = () => {
			setHeadings((previous) =>
				stabilizeHeadingIds(
					previous,
					collectTableOfContentsHeadings(editor.state.doc),
				),
			);
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

			setActiveHeadingId((current) =>
				current === active.id ? current : active.id,
			);
		};

		// Scroll/resize can fire far faster than the per-heading DOM
		// measurements above can keep up with on a heading-heavy document, so
		// coalesce to at most one measurement pass per animation frame.
		let pendingFrame: number | null = null;
		const scheduleUpdateActiveHeading = () => {
			if (pendingFrame !== null) return;
			pendingFrame = requestAnimationFrame(() => {
				pendingFrame = null;
				updateActiveHeading();
			});
		};

		// Every headings rebuild (each content edit) re-runs this effect; the
		// per-heading DOM reads above force layout, so only the initial mount
		// measures synchronously while edit-driven rebuilds join the same
		// once-per-frame coalesced pass as scroll/resize.
		if (measuredOnce.current) {
			scheduleUpdateActiveHeading();
		} else {
			measuredOnce.current = true;
			updateActiveHeading();
		}
		scrollContainer.addEventListener("scroll", scheduleUpdateActiveHeading, {
			passive: true,
		});
		window.addEventListener("resize", scheduleUpdateActiveHeading);
		return () => {
			if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
			scrollContainer.removeEventListener(
				"scroll",
				scheduleUpdateActiveHeading,
			);
			window.removeEventListener("resize", scheduleUpdateActiveHeading);
		};
	}, [editor, headings, scrollContainer]);

	// Section = from this heading's position up to (not including) the next
	// heading's position; `headings` is already in document order from
	// `collectTableOfContentsHeadings`'s `doc.descendants` walk, so "last
	// heading whose pos <= range.from" is equivalent to an interval match.
	// Maps heading id -> whether every comment in that section is resolved,
	// mirroring the resolved/unresolved dimming `CommentParagraphMarker`
	// already shows -- a heading with any open comment reads as
	// "needs attention", not just "has comments".
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

/**
 * Reassigns heading ids so list identity survives ordinary body edits.
 * `collectTableOfContentsHeadings` keys by document position, which shifts
 * on every keystroke above a heading and remounts the whole list (losing
 * focus and DOM state). Matching prefers identical level+title in occurrence
 * order, then nearest position for edited/added headings, so typing in body
 * text -- or inside a heading title -- keeps every item's React key while
 * positions and navigation targets still update every pass.
 */
let stableHeadingFallbackCounter = 0;

export function stabilizeHeadingIds(
	previous: TableOfContentsHeading[],
	collected: TableOfContentsHeading[],
): TableOfContentsHeading[] {
	const identityKey = (heading: TableOfContentsHeading) =>
		`${heading.level}|${heading.title}`;
	// Phase 1: identical level+title headings keep their identity in
	// occurrence order -- body-text edits never disturb these keys.
	const queues = new Map<string, string[]>();
	for (const heading of previous) {
		const queue = queues.get(identityKey(heading));
		if (queue) queue.push(heading.id);
		else queues.set(identityKey(heading), [heading.id]);
	}
	const assigned = new Map<number, string>();
	const consumed = new Set<string>();
	collected.forEach((heading, index) => {
		const id = queues.get(identityKey(heading))?.shift();
		if (id !== undefined) {
			assigned.set(index, id);
			consumed.add(id);
		}
	});
	// Phase 2: edited, added, or shifted headings reuse the nearest leftover
	// identity, so typing inside a heading title doesn't remount its row on
	// every keystroke either.
	const leftovers = previous.filter((heading) => !consumed.has(heading.id));
	const used = new Set(consumed);
	return collected.map((heading, index) => {
		const direct = assigned.get(index);
		if (direct !== undefined) return { ...heading, id: direct };
		let nearest: TableOfContentsHeading | undefined;
		let nearestDistance = Number.POSITIVE_INFINITY;
		for (const candidate of leftovers) {
			if (used.has(candidate.id)) continue;
			const distance = Math.abs(candidate.pos - heading.pos);
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearest = candidate;
			}
		}
		// Minted ids come from a module-level monotonic counter (never
		// recycled per pass): a deleted heading's fallback can never be
		// reissued to an unrelated later heading, so React can't reuse the
		// wrong row's DOM or focus.
		const id =
			nearest?.id ?? `heading-stable-${stableHeadingFallbackCounter++}`;
		used.add(id);
		return { ...heading, id };
	});
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
