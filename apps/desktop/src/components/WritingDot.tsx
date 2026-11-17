/**
 * "The dot": select text → a small dot at the selection's end; hover it for
 * the writing tools. A local tool's result arrives as an inline suggestion;
 * an `engine: agent` tool becomes a `tool.requested` event for a watching
 * agent, whose answer arrives as a suggestion via `propose_edit`.
 *
 * One status owner: `run` (idle → running → idle | failed), per mount.
 */
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { desktopApi } from "../desktopApi";
import type { WritingTool } from "../desktopApi/types";
import { findTextRange } from "../editor/SuggestionExtension";
import { loadPath } from "../store/actions";

type Anchor = { from: number; to: number; x: number; y: number };
type RunState =
	| { status: "idle" }
	| { status: "running"; toolName: string }
	| { status: "failed"; error: string };

export function selectionAnchor(editor: Editor): Anchor | null {
	const { from, to, empty } = editor.state.selection;
	if (empty || !editor.isEditable) return null;
	if (!editor.state.doc.textBetween(from, to, "\n").trim()) return null;
	try {
		const coords = editor.view.coordsAtPos(to);
		return { from, to, x: coords.right + 6, y: coords.top };
	} catch {
		return null;
	}
}

let runCounter = 0;

export function WritingDot({
	editor,
	path,
	hasWatcher,
}: {
	editor: Editor | null;
	path: string;
	hasWatcher: boolean;
}) {
	const [anchor, setAnchor] = useState<Anchor | null>(null);
	const [open, setOpen] = useState(false);
	const [tools, setTools] = useState<WritingTool[] | null>(null);
	const [run, setRun] = useState<RunState>({ status: "idle" });
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!editor) return;
		const update = () => setAnchor(selectionAnchor(editor));
		editor.on("selectionUpdate", update);
		editor.on("blur", update);
		return () => {
			editor.off("selectionUpdate", update);
			editor.off("blur", update);
		};
	}, [editor]);

	const loadTools = useCallback(() => {
		desktopApi
			.listWritingTools(path)
			.then(setTools)
			.catch((error: unknown) => {
				toast.error("Could not load writing tools", {
					description: error instanceof Error ? error.message : String(error),
				});
			});
	}, [path]);

	const show = () => {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		if (!tools) loadTools();
		setOpen(true);
	};
	const hide = () => {
		closeTimer.current = setTimeout(() => setOpen(false), 250);
	};

	const runTool = async (tool: WritingTool) => {
		if (!editor || !anchor || run.status === "running") return;
		const { from, to } = anchor;
		const text = editor.state.doc.textBetween(from, to, "\n");
		const requestId = `t${Date.now().toString(36)}${++runCounter}`;
		setOpen(false);
		setRun({ status: "running", toolName: tool.name });
		try {
			const result = await desktopApi.runWritingTool(path, {
				toolId: tool.id,
				text,
				requestId,
			});
			if (result.status === "sent-to-agent") {
				setRun({ status: "idle" });
				if (hasWatcher) toast.success(`${tool.name}: sent to the agent`);
				else
					toast.warning(
						`${tool.name} is an agent tool, but no agent is watching this note`,
						{
							description:
								"Run `mdly watch <note>` in an agent session, or edit the tool file to use engine: local.",
						},
					);
				return;
			}
			if (result.status === "cancelled") {
				setRun({ status: "idle" });
				toast.message(`${tool.name} cancelled`);
				return;
			}
			if (result.status === "failed") {
				const missing = result.engine?.state === "missing";
				setRun({ status: "failed", error: result.error });
				toast.error(missing ? "Local model not found" : `${tool.name} failed`, {
					description: missing
						? `${result.engine?.modelPath} — set the model path in Settings.`
						: result.error,
				});
				return;
			}
			setRun({ status: "idle" });
			const stillThere = editor.state.doc.textBetween(from, to, "\n") === text;
			const range = stillThere
				? { from, to }
				: findTextRange(editor.state.doc, text);
			if (!range || result.text === text) {
				toast.message(
					range
						? `${tool.name}: no changes`
						: "The selected text changed while the tool ran",
				);
				return;
			}
			editor.commands.addSuggestion({
				groupId: requestId,
				source: "tool",
				...range,
				newText: result.text,
				label: tool.name,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setRun({ status: "failed", error: message });
			toast.error(`${tool.name} failed`, { description: message });
		}
	};

	const reset = async (tool: WritingTool) => {
		await desktopApi.resetWritingTool(path, tool.id);
		loadTools();
		toast.success(`${tool.name} prompt reset to default`);
	};

	if (!editor || (!anchor && run.status !== "running")) return null;
	const position = anchor ?? { x: 0, y: 0 };
	return (
		<div
			role="toolbar"
			aria-label="Writing tools"
			className="fixed z-50"
			style={{ insetInlineStart: position.x, insetBlockStart: position.y }}
			onMouseEnter={show}
			onMouseLeave={hide}
			data-testid="writing-dot"
		>
			<button
				type="button"
				aria-label="Writing tools"
				onMouseDown={(event) => event.preventDefault()}
				onClick={show}
				className={`block size-3 rounded-full border border-background shadow ${
					run.status === "running"
						? "animate-pulse bg-amber-500"
						: run.status === "failed"
							? "bg-red-500"
							: "bg-primary"
				}`}
				title={run.status === "running" ? `${run.toolName}…` : "Writing tools"}
			/>
			{run.status === "running" && (
				<button
					type="button"
					className="absolute whitespace-nowrap rounded-full border border-border bg-popover px-2 py-0.5 text-xs shadow"
					style={{ insetBlockStart: -4, insetInlineStart: 16 }}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => void desktopApi.cancelWritingTool()}
					data-testid="writing-dot-cancel"
				>
					Cancel {run.toolName}
				</button>
			)}
			{open && anchor && (
				<div
					role="menu"
					className="absolute min-w-44 rounded-lg border border-border bg-popover p-1 text-sm shadow-lg"
					style={{ insetBlockStart: 16, insetInlineStart: 0 }}
					onMouseDown={(event) => event.preventDefault()}
				>
					{!tools && (
						<div className="px-2 py-1 text-muted-foreground">Loading…</div>
					)}
					{tools?.map((tool) => (
						<div key={tool.id} className="group flex items-center gap-1">
							<button
								type="button"
								className="flex flex-1 items-center justify-between gap-3 rounded px-2 py-1 text-start hover:bg-muted"
								onClick={() => void runTool(tool)}
							>
								<span>{tool.name}</span>
								<span className="text-[10px] uppercase text-muted-foreground">
									{tool.engine}
								</span>
							</button>
							<button
								type="button"
								className="invisible rounded px-1 text-xs text-muted-foreground hover:bg-muted group-hover:visible"
								title="Edit prompt"
								onClick={() => void loadPath(tool.filePath)}
							>
								✎
							</button>
							{tool.builtIn && (
								<button
									type="button"
									className="invisible rounded px-1 text-xs text-muted-foreground hover:bg-muted group-hover:visible"
									title="Reset prompt to default"
									onClick={() => void reset(tool)}
								>
									↺
								</button>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
