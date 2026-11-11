import type { Editor } from "@tiptap/core";
import { Command } from "cmdk";
import {
	type ComponentType,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import MingcuteBorderHorizontalLine from "~icons/mingcute/border-horizontal-line";
import MingcuteHeading1Line from "~icons/mingcute/heading-1-line";
import MingcuteHeading2Line from "~icons/mingcute/heading-2-line";
import MingcuteHeading3Line from "~icons/mingcute/heading-3-line";
import MingcuteColumnsLine from "~icons/mingcute/layout-6-line";
import MingcuteListCheck2Line from "~icons/mingcute/list-check-2-line";
import MingcuteListCheckLine from "~icons/mingcute/list-check-line";
import MingcuteListOrderedLine from "~icons/mingcute/list-ordered-line";
import MingcuteMindMapLine from "~icons/mingcute/mind-map-line";
import MingcutePicLine from "~icons/mingcute/pic-line";
import MingcuteQuoteLeftLine from "~icons/mingcute/quote-left-line";
import MingcuteRightLine from "~icons/mingcute/right-line";
import MingcuteStrikethroughLine from "~icons/mingcute/strikethrough-line";
import MingcuteTextLine from "~icons/mingcute/text-line";
import MingcuteWebLine from "~icons/mingcute/web-line";
import { parseEmbedInput } from "../engine/embedInput.js";
import { cn } from "../lib/utils";
import { useCommandMenuPosition } from "./commandMenuPosition";
import {
	applySlashCommand,
	findSlashToken,
	type SlashCommandKind,
	type SlashToken,
} from "./slashCommandActions";

type SlashCommand = {
	kind: SlashCommandKind;
	title: string;
	description: string;
	aliases: string[];
	icon: ComponentType<{ className?: string }>;
};

type MenuPosition = {
	x: number;
	y: number;
};

const SLASH_COMMANDS: SlashCommand[] = [
	{
		kind: "paragraph",
		title: "Text",
		description: "Start a plain text block",
		aliases: ["paragraph", "plain"],
		icon: MingcuteTextLine,
	},
	{
		kind: "heading1",
		title: "Heading 1",
		description: "Large section heading",
		aliases: ["h1", "#", "title"],
		icon: MingcuteHeading1Line,
	},
	{
		kind: "heading2",
		title: "Heading 2",
		description: "Medium section heading",
		aliases: ["h2", "##", "subtitle"],
		icon: MingcuteHeading2Line,
	},
	{
		kind: "heading3",
		title: "Heading 3",
		description: "Small section heading",
		aliases: ["h3", "###"],
		icon: MingcuteHeading3Line,
	},
	{
		kind: "bulletList",
		title: "Bulleted list",
		description: "Create a simple list",
		aliases: ["bullet", "bullets", "ul", "list"],
		icon: MingcuteListCheckLine,
	},
	{
		kind: "orderedList",
		title: "Numbered list",
		description: "Create an ordered list",
		aliases: ["number", "numbered", "ol", "1."],
		icon: MingcuteListOrderedLine,
	},
	{
		kind: "taskList",
		title: "To-do list",
		description: "Create a task list",
		aliases: ["todo", "task", "check", "checkbox"],
		icon: MingcuteListCheck2Line,
	},
	{
		kind: "blockquote",
		title: "Quote",
		description: "Create a quote block",
		aliases: ["blockquote", ">"],
		icon: MingcuteQuoteLeftLine,
	},
	{
		kind: "toggle",
		title: "Toggle list",
		description: "Collapsible content with a hidden section",
		aliases: ["toggle", "details", "collapse", "expand", "summary"],
		icon: MingcuteRightLine,
	},
	{
		kind: "mermaid",
		title: "Mermaid diagram",
		description: "Insert a diagram (flowchart, sequence…)",
		aliases: ["mermaid", "diagram", "flowchart", "graph", "chart"],
		icon: MingcuteMindMapLine,
	},
	{
		kind: "columns",
		title: "Columns",
		description: "Two side-by-side columns",
		aliases: ["columns", "column", "side", "grid", "layout", "compare"],
		icon: MingcuteColumnsLine,
	},
	{
		kind: "embed",
		title: "Embed",
		description: "Paste iframe code or an https URL",
		aliases: ["embed", "iframe", "video", "youtube", "web", "url"],
		icon: MingcuteWebLine,
	},
	{
		kind: "image",
		title: "Image",
		description: "Insert images from your files",
		aliases: ["image", "photo", "picture", "img", "pic"],
		icon: MingcutePicLine,
	},
	{
		kind: "divider",
		title: "Divider",
		description: "Separate sections",
		aliases: ["hr", "horizontal", "rule", "separator", "---"],
		icon: MingcuteBorderHorizontalLine,
	},
	{
		kind: "strike",
		title: "Strikethrough",
		description: "Toggle strikethrough",
		aliases: ["strike", "s", "delete"],
		icon: MingcuteStrikethroughLine,
	},
];

export function SlashCommandMenu({
	editor,
	viewportRef,
	onInsertImage,
}: {
	editor: Editor | null;
	viewportRef: RefObject<HTMLDivElement | null>;
	/** Host image picker; `/image` is only offered when provided. */
	onInsertImage?: (editor: Editor) => void;
}) {
	const [token, setToken] = useState<SlashToken | null>(null);
	const [embedPrompt, setEmbedPrompt] = useState<{
		token: SlashToken;
		position: MenuPosition | null;
	} | null>(null);
	const [position, setPosition] = useState<MenuPosition | null>(null);
	const [selectedKind, setSelectedKind] =
		useState<SlashCommandKind>("paragraph");
	const suppressedFromRef = useRef<number | null>(null);
	const positionedFromRef = useRef<number | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const visibleCommands = SLASH_COMMANDS.filter(
		(command) =>
			(command.kind !== "embed" || Boolean(editor?.schema.nodes.embed)) &&
			(command.kind !== "image" || Boolean(onInsertImage)) &&
			matchesCommand(command, token?.query ?? ""),
	);
	const runCommand = (kind: SlashCommandKind, activeToken: SlashToken) => {
		if (!editor) return;
		if (kind === "embed") {
			// The prompt takes focus, which blurs the editor and clears `token`;
			// keep the token range so the embed replaces `/embed` on submit.
			setEmbedPrompt({ token: activeToken, position });
			return;
		}
		applySlashCommand(editor, activeToken, kind, { onInsertImage });
	}; // Read through a ref so the keydown effect always sees the latest closure.
	const runCommandRef = useRef(runCommand);
	runCommandRef.current = runCommand;

	// Keep selection visible even when the current query filters out the
	// previously selected command.
	const activeKind = visibleCommands.some(
		(command) => command.kind === selectedKind,
	)
		? selectedKind
		: visibleCommands[0]?.kind;

	useEffect(() => {
		if (!editor) return;
		const viewport = viewportRef.current;

		// The query lives in ProseMirror text, not in the cmdk input. Recompute
		// the token and anchor whenever the editor may have moved.
		const update = () => {
			const nextToken = findSlashToken(editor);
			if (!nextToken) {
				suppressedFromRef.current = null;
				positionedFromRef.current = null;
				setToken(null);
				setPosition(null);
				return;
			}
			if (suppressedFromRef.current === nextToken.from) {
				positionedFromRef.current = null;
				setToken(null);
				setPosition(null);
				return;
			}
			if (positionedFromRef.current !== nextToken.from) {
				positionedFromRef.current = nextToken.from;
				// Seed an approximate position synchronously so the first paint
				// lands near the cursor. cmdk scrolls the selected item into
				// view on mount; rendering hidden at 0,0 before floating-ui
				// positions the menu would yank the viewport scroll to the top.
				// floating-ui refines this estimate right after mount.
				try {
					const viewportEl = viewportRef.current;
					if (viewportEl) {
						const coords = editor.view.coordsAtPos(nextToken.from);
						const rect = viewportEl.getBoundingClientRect();
						setPosition({
							x: coords.left - rect.left + viewportEl.scrollLeft,
							y: coords.bottom - rect.top + viewportEl.scrollTop + 6,
						});
					} else {
						setPosition(null);
					}
				} catch {
					setPosition(null);
				}
			}
			setToken(nextToken);
		};

		update();
		editor.on("transaction", update);
		editor.on("selectionUpdate", update);
		editor.on("focus", update);
		editor.on("blur", update);
		viewport?.addEventListener("scroll", update, { passive: true });
		window.addEventListener("resize", update);

		return () => {
			editor.off("transaction", update);
			editor.off("selectionUpdate", update);
			editor.off("focus", update);
			editor.off("blur", update);
			viewport?.removeEventListener("scroll", update);
			window.removeEventListener("resize", update);
		};
	}, [editor, viewportRef]);

	useCommandMenuPosition({
		editor,
		floatingRef: menuRef,
		pos: token?.from ?? null,
		setPosition,
		viewportRef,
	});

	useEffect(() => {
		if (!editor) return;

		// Keep focus in the editor so typing continues to update the document;
		// the menu only handles navigation and command selection keys.
		const handleKeyDown = (event: KeyboardEvent) => {
			if (!token) return;
			if (event.key === "Escape") {
				event.preventDefault();
				suppressedFromRef.current = token.from;
				setToken(null);
				setPosition(null);
				return;
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const currentIndex = visibleCommands.findIndex(
					(command) => command.kind === activeKind,
				);
				if (currentIndex === -1) return;
				const direction = event.key === "ArrowDown" ? 1 : -1;
				const nextIndex =
					(currentIndex + direction + visibleCommands.length) %
					visibleCommands.length;
				setSelectedKind(visibleCommands[nextIndex].kind);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				const selectedCommand = visibleCommands.find(
					(command) => command.kind === activeKind,
				);
				if (!selectedCommand) return;
				event.preventDefault();
				runCommandRef.current(selectedCommand.kind, token);
				suppressedFromRef.current = null;
				setToken(null);
				setPosition(null);
			}
		};

		editor.view.dom.addEventListener("keydown", handleKeyDown, true);
		return () =>
			editor.view.dom.removeEventListener("keydown", handleKeyDown, true);
	}, [activeKind, editor, token, visibleCommands]);

	if (editor && embedPrompt) {
		return (
			<EmbedPrompt
				editor={editor}
				token={embedPrompt.token}
				position={embedPrompt.position}
				onClose={() => setEmbedPrompt(null)}
			/>
		);
	}

	if (!editor || !token || visibleCommands.length === 0) {
		return null;
	}

	return (
		<div
			ref={menuRef}
			className="absolute z-[4] w-[250px] overflow-hidden rounded-[18px] bg-popover text-popover-foreground shadow-overlay"
			style={{
				insetInlineStart: `${position?.x ?? 0}px`,
				insetBlockStart: `${position?.y ?? 0}px`,
				visibility: position ? "visible" : "hidden",
			}}
		>
			<Command
				label="Slash commands"
				value={activeKind}
				onValueChange={(value) => setSelectedKind(value as SlashCommandKind)}
				shouldFilter={false}
				loop
				onMouseDown={(event) => event.preventDefault()}
			>
				<Command.Input
					value={token.query}
					readOnly
					className="sr-only"
					aria-hidden="true"
					tabIndex={-1}
				/>
				<Command.List className="max-h-64 overflow-y-auto p-1">
					{visibleCommands.map((command) => {
						const Icon = command.icon;
						return (
							<Command.Item
								key={command.kind}
								value={command.kind}
								keywords={[
									command.title,
									command.description,
									...command.aliases,
								]}
								onSelect={() => {
									runCommand(command.kind, token);
									setToken(null);
									setPosition(null);
								}}
								className={cn(
									"flex min-w-0 cursor-default items-center gap-2 rounded-[var(--radius-inner)] px-2 py-1.5 text-start text-[11px] leading-[15px] outline-hidden",
									"data-[selected=true]:bg-accent data-[selected=true]:text-foreground",
								)}
							>
								<span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
									<Icon className="size-3.5" />
								</span>
								<span className="block min-w-0 flex-1 truncate text-foreground">
									{command.title}
								</span>
							</Command.Item>
						);
					})}
				</Command.List>
			</Command>
		</div>
	);
}

/**
 * Inline `/embed` prompt: paste `<iframe …>` code or an https URL. Input goes
 * through `parseEmbedInput` (the same rules as opening a file); invalid input
 * shows an inline error instead of inserting anything.
 */
function EmbedPrompt({
	editor,
	token,
	position,
	onClose,
}: {
	editor: Editor;
	token: SlashToken;
	position: MenuPosition | null;
	onClose: () => void;
}) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);

	const close = () => {
		onClose();
		editor.commands.focus();
	};
	const submit = () => {
		const result = parseEmbedInput(value);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		// The document may have changed while the prompt was open; only replace
		// the token range if it still holds the slash text.
		const { doc, selection } = editor.state;
		const stillToken =
			token.to <= doc.content.size &&
			doc.textBetween(token.from, token.to).startsWith("/");
		const target = stillToken
			? token
			: { from: selection.from, to: selection.from, query: "" };
		onClose();
		applySlashCommand(editor, target, "embed", { embedAttrs: result.attrs });
	};

	return (
		<div
			className="absolute z-[4] flex w-[340px] flex-col gap-2 rounded-[18px] bg-popover p-3 text-popover-foreground shadow-overlay"
			style={{
				insetInlineStart: `${position?.x ?? 0}px`,
				insetBlockStart: `${position?.y ?? 0}px`,
			}}
		>
			<textarea
				// biome-ignore lint/a11y/noAutofocus: the prompt opens from a keyboard command and must take input immediately
				autoFocus
				aria-label="Iframe code or https URL"
				placeholder={'<iframe src="https://…"></iframe> or https://…'}
				rows={3}
				value={value}
				onChange={(event) => {
					setValue(event.target.value);
					setError(null);
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						close();
					} else if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						submit();
					}
				}}
				className="w-full resize-none rounded-[var(--radius-inner)] bg-accent/40 px-2 py-1.5 font-mono text-[11px] leading-[15px] outline-hidden"
			/>
			{error ? (
				<p role="alert" className="text-[11px] leading-[15px] text-destructive">
					{error}
				</p>
			) : null}
			<div className="flex justify-end gap-2 text-[11px]">
				<button
					type="button"
					onClick={close}
					className="rounded-[var(--radius-inner)] px-2 py-1 text-muted-foreground hover:bg-accent"
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={submit}
					className="rounded-[var(--radius-inner)] bg-accent px-2 py-1 text-foreground"
				>
					Embed
				</button>
			</div>
		</div>
	);
}

function matchesCommand(command: SlashCommand, query: string) {
	if (query.trim() === "") return true;
	return (
		commandScore(command.kind, query, [
			command.title,
			command.description,
			...command.aliases,
		]) > 0
	);
}

function commandScore(value: string, search: string, keywords: string[]) {
	const normalizedSearch = normalize(search);
	if (!normalizedSearch) return 1;
	const haystacks = [value, ...keywords].map(normalize);
	let best = 0;
	for (const haystack of haystacks) {
		if (haystack === normalizedSearch) best = Math.max(best, 1);
		else if (haystack.startsWith(normalizedSearch)) best = Math.max(best, 0.9);
		else if (haystack.includes(normalizedSearch)) best = Math.max(best, 0.75);
		else if (isSubsequence(normalizedSearch, haystack)) {
			best = Math.max(best, 0.45);
		}
	}
	return best;
}

function normalize(value: string) {
	return value.toLowerCase().replace(/[\s_-]+/g, "");
}

function isSubsequence(needle: string, haystack: string) {
	let index = 0;
	for (const char of haystack) {
		if (char === needle[index]) index++;
		if (index === needle.length) return true;
	}
	return false;
}
