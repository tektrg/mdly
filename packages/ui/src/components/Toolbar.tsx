import { isMac } from "keymatch";
import {
	type CSSProperties,
	type HTMLAttributes,
	useEffect,
	useState,
} from "react";
import MingcuteAddLine from "~icons/mingcute/add-line";
import MingcuteLayoutLeftLine from "~icons/mingcute/layout-left-line";
import { Button } from "../primitives/button";

const TOOLBAR_INSET = isMac()
	? "var(--hubble-traffic-light-inset, 70px)"
	: "8px";
const ACTIONS_BASIS = "114px";
const NO_DRAG_STYLE = {
	WebkitAppRegion: "no-drag",
} as CSSProperties;

function ToolbarActions({ children }: { children?: React.ReactNode }) {
	return (
		<div
			className="px-2"
			style={{ flex: `0 100 ${ACTIONS_BASIS}`, ...NO_DRAG_STYLE }}
		>
			{children}
		</div>
	);
}

export function Toolbar({
	sidebarOpen,
	sidebarBadge,
	scrollContainer,
	platformInset = true,
	leftSlot,
	rightSlot,
	onToggleSidebar,
	rootProps,
}: {
	currentPath: string | null;
	sidebarOpen: boolean;
	sidebarBadge?: boolean;
	scrollContainer?: HTMLDivElement | null;
	platformInset?: boolean;
	leftSlot?: React.ReactNode;
	rightSlot?: React.ReactNode;
	onToggleSidebar?: () => void;
	onRenameCurrentPath?: (nextName: string) => void | Promise<void>;
	rootProps?: HTMLAttributes<HTMLDivElement> &
		Record<`data-${string}`, unknown>;
}) {
	const [showBorder, setShowBorder] = useState(false);

	useEffect(() => {
		if (!scrollContainer) {
			setShowBorder(false);
			return;
		}
		const update = () => setShowBorder(scrollContainer.scrollTop > 0);
		update();
		scrollContainer.addEventListener("scroll", update, { passive: true });
		return () => scrollContainer.removeEventListener("scroll", update);
	}, [scrollContainer]);

	const chromeClass = sidebarOpen
		? "shadow-chrome-bar"
		: showBorder
			? "shadow-chrome-bar"
			: "shadow-none";

	return (
		<div
			{...rootProps}
			className={`flex h-9 items-center ${chromeClass} ${rootProps?.className ?? ""}`}
		>
			<ToolbarActions>
				<div
					className="flex items-center gap-1"
					style={{ paddingInlineStart: platformInset ? TOOLBAR_INSET : 0 }}
				>
					{onToggleSidebar && (
						<Button
							variant="ghost"
							size="icon-sm"
							className="relative"
							onClick={onToggleSidebar}
							aria-label="Toggle sidebar"
						>
							<MingcuteLayoutLeftLine className="size-4" />
							{sidebarBadge ? (
								<span className="absolute top-1 end-1 size-1.5 rounded-full bg-primary" />
							) : null}
						</Button>
					)}
					{leftSlot}
				</div>
			</ToolbarActions>
			<div className="min-w-0" style={{ flex: "1 1 auto" }} />
			<ToolbarActions>
				<div className="flex items-center justify-end">{rightSlot}</div>
			</ToolbarActions>
		</div>
	);
}

export function NewNoteButton({ onClick }: { onClick: () => void }) {
	return (
		<Button
			variant="ghost"
			size="icon-sm"
			onClick={onClick}
			aria-label="New Markdown File"
			title="New Markdown File (⌘N)"
		>
			<MingcuteAddLine className="size-4" />
		</Button>
	);
}
