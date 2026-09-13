import { Menu } from "@base-ui/react/menu";
import type { Editor } from "@tiptap/core";
import { useState } from "react";
import MingcuteMenuLine from "~icons/mingcute/menu-line";
import MingcuteMessage3Line from "~icons/mingcute/message-3-line";
import type { ResolvedThread } from "../comments/index.js";
import { usePortalContainer } from "../lib/portalContainer";
import { MOBILE_MEDIA_QUERY, useMediaQuery } from "../lib/useMediaQuery";
import { BottomSheet } from "../primitives/bottomSheet.js";
import { Button } from "../primitives/button";
import {
	type TableOfContentsHeading,
	useTocHeadings,
} from "./useTocHeadings.js";

type Props = {
	editor: Editor | null;
	scrollContainer: HTMLDivElement | null;
	/** Same opt-in as `TableOfContents`: comment badges per section. */
	threads?: ResolvedThread[];
};

/**
 * Toolbar table-of-contents entry point, shared by every width: a list-icon
 * trigger that opens a dropdown menu on desktop and a `BottomSheet` on
 * phones (below `md`). Both surfaces render the same heading data, active
 * highlight, and comment badges as the hover rail (`TableOfContents`), which
 * is untouched. Hidden entirely when the doc has no headings.
 */
export function TableOfContentsMenu({
	editor,
	scrollContainer,
	threads,
}: Props) {
	const portalContainer = usePortalContainer();
	const isMobile = useMediaQuery(MOBILE_MEDIA_QUERY);
	const [open, setOpen] = useState(false);
	const { headings, activeHeadingId, headingCommentState, scrollToHeading } =
		useTocHeadings(editor, scrollContainer, threads);

	if (!editor || headings.length === 0) return null;

	const select = (heading: TableOfContentsHeading) => {
		setOpen(false);
		scrollToHeading(heading);
	};

	const trigger = (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label="Table of contents"
			title="Table of contents"
			onClick={isMobile ? () => setOpen(true) : undefined}
		>
			<MingcuteMenuLine className="size-4" />
		</Button>
	);

	if (isMobile) {
		return (
			<>
				{trigger}
				<BottomSheet open={open} onOpenChange={setOpen} title="Contents">
					<ul
						className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-y-auto p-0"
						data-toc-sheet-list
					>
						{headings.map((heading) => (
							<li key={heading.id}>
								<button
									type="button"
									className="flex min-h-11 w-full items-center gap-2 rounded-[var(--radius-inner)] bg-transparent px-2 py-2 text-start text-sm text-muted-foreground data-[active=true]:bg-accent data-[active=true]:text-foreground"
									data-active={heading.id === activeHeadingId}
									data-level={heading.level}
									style={{
										paddingInlineStart: `calc(0.5rem + ${(Math.min(heading.level, 6) - 1) * 1.1}rem)`,
									}}
									onClick={() => select(heading)}
								>
									<span className="min-w-0 flex-1">{heading.title}</span>
									{headingCommentState.has(heading.id) ? (
										<MingcuteMessage3Line
											className="size-3.5 shrink-0"
											aria-hidden="true"
											data-comment-indicator
											data-resolved={headingCommentState.get(heading.id)}
										/>
									) : null}
								</button>
							</li>
						))}
					</ul>
				</BottomSheet>
			</>
		);
	}

	return (
		<Menu.Root open={open} onOpenChange={setOpen}>
			<Menu.Trigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Table of contents"
						title="Table of contents"
					/>
				}
			>
				<MingcuteMenuLine className="size-4" />
			</Menu.Trigger>
			<Menu.Portal container={portalContainer}>
				<Menu.Positioner
					className="z-50"
					align="end"
					side="bottom"
					sideOffset={4}
				>
					<Menu.Popup className="max-h-96 w-64 origin-(--transform-origin) overflow-y-auto rounded-[var(--radius-popover)] border border-border bg-popover p-1 text-popover-foreground shadow-overlay outline-hidden">
						{headings.map((heading) => (
							<Menu.Item
								key={heading.id}
								className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-start text-xs outline-hidden select-none data-highlighted:bg-accent"
								data-active={heading.id === activeHeadingId}
								onClick={() => select(heading)}
							>
								<span
									className="min-w-0 flex-1 truncate text-muted-foreground"
									style={{
										paddingInlineStart: `${(Math.min(heading.level, 6) - 1) * 0.9}rem`,
									}}
								>
									{heading.title}
								</span>
								{headingCommentState.has(heading.id) ? (
									<MingcuteMessage3Line
										className="size-3.5 shrink-0"
										aria-hidden="true"
										data-comment-indicator
										data-resolved={headingCommentState.get(heading.id)}
									/>
								) : null}
							</Menu.Item>
						))}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
