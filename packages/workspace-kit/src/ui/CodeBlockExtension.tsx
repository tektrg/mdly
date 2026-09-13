import { Select } from "@base-ui/react/select";
import { findChildren } from "@tiptap/core";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
	NodeViewContent,
	type NodeViewProps,
	NodeViewWrapper,
	ReactNodeViewRenderer,
} from "@tiptap/react";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import { createLowlight } from "lowlight";
import { useState } from "react";
import MingcuteCheckLine from "~icons/mingcute/check-line";
import MingcuteCopy2Line from "~icons/mingcute/copy-2-line";
import { usePortalContainer } from "../lib/portalContainer";
import { Button } from "../primitives/button";

const DEFAULT_TAB_SIZE = 4;
const TWO_SPACE_LANGUAGES = new Set([
	"css",
	"html",
	"js",
	"json",
	"jsx",
	"md",
	"ts",
	"tsx",
]);
export const CODE_BLOCK_COPY_EVENT = "hubble:code-block-copy";

// Register only the languages common to md/html workspaces instead of
// lowlight's full `common` set (~35 grammars) to keep the startup bundle lean.
const lowlight = createLowlight({
	bash,
	css,
	javascript,
	json,
	markdown,
	python,
	typescript,
	xml,
});
lowlight.registerAlias({
	javascript: ["js", "jsx"],
	typescript: ["ts", "tsx"],
	xml: ["html"],
	bash: ["sh", "shell"],
	markdown: ["md"],
});

export const HubbleCodeBlock = CodeBlockLowlight.extend({
	addProseMirrorPlugins() {
		// Override (do NOT call this.parent): Tiptap binds the inherited
		// CodeBlockLowlight factory as this.parent, so spreading it would
		// register the Lowlight plugin twice and rehighlight every code block
		// twice per edit. A single Hubble-scoped plugin also caches
		// per-block highlight output, so only added/changed blocks pay for
		// highlighting while unchanged blocks reuse their parsed nodes.
		return [
			hubbleLowlightPlugin({
				name: this.name,
				lowlight: this.options.lowlight,
				defaultLanguage: this.options.defaultLanguage,
			}),
		];
	},
	addKeyboardShortcuts() {
		return {
			...this.parent?.(),
			Tab: ({ editor }) => {
				const { state } = editor;
				const { selection } = state;
				const { $from, empty } = selection;
				if ($from.parent.type !== this.type) return false;

				const tabSize = tabSizeForLanguage($from.parent.attrs.language);
				const indent = " ".repeat(tabSize);

				if (empty) {
					return editor.commands.insertContent(indent);
				}

				return editor.commands.command(({ tr }) => {
					const { from, to } = selection;
					const text = state.doc.textBetween(from, to, "\n", "\n");
					const indentedText = text
						.split("\n")
						.map((line) => indent + line)
						.join("\n");
					tr.replaceWith(from, to, state.schema.text(indentedText));
					return true;
				});
			},
			Backspace: ({ editor }) => {
				const { state } = editor;
				const { selection } = state;
				if (!selection.empty) return false;

				const { $from } = selection;
				if ($from.parent.type !== this.type) return false;

				const blockStart = $from.start();
				const textBeforeCursor = state.doc.textBetween(
					blockStart,
					$from.pos,
					"\n",
					"\n",
				);
				const lineStart = textBeforeCursor.lastIndexOf("\n") + 1;
				const column = textBeforeCursor.length - lineStart;
				const linePrefix = textBeforeCursor.slice(lineStart);
				const tabSize = tabSizeForLanguage($from.parent.attrs.language);
				const previousSegment = linePrefix.slice(-tabSize);

				// Treat soft-tab spaces as one indentation unit at tab stops.
				if (
					column === 0 ||
					column % tabSize !== 0 ||
					previousSegment !== " ".repeat(tabSize)
				) {
					return false;
				}

				return editor.commands.command(({ tr }) => {
					const from = $from.pos - tabSize;
					tr.delete(from, $from.pos);
					tr.setSelection(TextSelection.create(tr.doc, from));
					return true;
				});
			},
		};
	},
	addNodeView() {
		return ReactNodeViewRenderer(CodeBlockView);
	},
}).configure({
	lowlight,
	enableTabIndentation: false,
	tabSize: DEFAULT_TAB_SIZE,
});

function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
	const language =
		typeof node.attrs.language === "string" ? node.attrs.language : "";
	const [selectOpen, setSelectOpen] = useState(false);
	const portalContainer = usePortalContainer();

	return (
		<NodeViewWrapper className="pm-code-block" as="div">
			<div
				className="pm-code-block-controls"
				contentEditable={false}
				data-select-open={selectOpen}
			>
				<Select.Root
					open={selectOpen}
					onOpenChange={setSelectOpen}
					value={language}
					onValueChange={(next) => updateAttributes({ language: next || null })}
				>
					<Select.Trigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="xs"
								aria-label="Code block language"
								title="Code block language"
								className="pm-code-block-language"
							/>
						}
					>
						<Select.Value>
							{languageLabel(language) || "Plain text"}
						</Select.Value>
					</Select.Trigger>
					<Select.Portal container={portalContainer}>
						<Select.Positioner
							className="z-50"
							align="end"
							side="bottom"
							sideOffset={8}
						>
							<Select.Popup className="w-40 origin-(--transform-origin) rounded-[var(--radius-popover)] border border-border bg-popover p-1 text-[11px] text-popover-foreground shadow-overlay outline-hidden transition-[transform,opacity] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
								{codeBlockLanguages.map((option) => (
									<Select.Item
										key={option.value}
										value={option.value}
										className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-start text-[11px] text-foreground outline-hidden select-none data-highlighted:bg-accent"
									>
										<Select.ItemIndicator className="inline-flex" keepMounted>
											<MingcuteCheckLine className="size-3 [[data-selected]_&]:opacity-100 opacity-0" />
										</Select.ItemIndicator>
										<Select.ItemText>{option.label}</Select.ItemText>
									</Select.Item>
								))}
							</Select.Popup>
						</Select.Positioner>
					</Select.Portal>
				</Select.Root>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label="Copy code"
					title="Copy code"
					onClick={() => {
						void copyCodeBlock(node.textContent);
					}}
				>
					<MingcuteCopy2Line className="size-3.5" />
				</Button>
			</div>
			<pre>
				<NodeViewContent<"code">
					as="code"
					className={language ? `language-${language}` : undefined}
				/>
			</pre>
		</NodeViewWrapper>
	);
}

function languageLabel(value: string) {
	return codeBlockLanguages.find((option) => option.value === value)?.label;
}

function tabSizeForLanguage(language: unknown) {
	return typeof language === "string" && TWO_SPACE_LANGUAGES.has(language)
		? 2
		: DEFAULT_TAB_SIZE;
}

type HighlightSpan = { text: string; classes: string[] };

// Minimal structural surface of the lowlight instance this plugin needs.
// (Kept local instead of `any` so the highlighter boundary stays typed;
// the extension option itself remains upstream's `lowlight: any`.)
type LowlightHastNode = {
	value?: string;
	properties?: { className?: string[] };
	children?: LowlightHastNode[];
};

type LowlightResult = {
	value?: LowlightHastNode[];
	children?: LowlightHastNode[];
};

type LowlightInstance = {
	listLanguages(): string[];
	registered?(language: string): boolean;
	highlight(language: string, value: string): LowlightResult;
	highlightAuto(value: string): LowlightResult;
};

// Parsed highlight output per code block, cached by language+text so edits to
// one block never re-run highlighting for the others. Bounded with a simple
// clear-on-overflow; correctness never depends on cache retention.
const HIGHLIGHT_CACHE_LIMIT = 1000;

function parseHighlightNodes(
	nodes: LowlightHastNode[],
	className: string[] = [],
): HighlightSpan[] {
	return nodes.flatMap((node) => {
		const classes = [...className, ...(node.properties?.className ?? [])];
		if (node.children) return parseHighlightNodes(node.children, classes);
		return {
			text: typeof node.value === "string" ? node.value : "",
			classes,
		};
	});
}

function highlightResultNodes(result: LowlightResult): LowlightHastNode[] {
	// `.value` for lowlight v1, `.children` for lowlight v2.
	return result.value ?? result.children ?? [];
}

function cachedHighlightSpans(
	lowlight: LowlightInstance,
	cache: Map<string, HighlightSpan[]>,
	language: string | null | undefined,
	text: string,
): HighlightSpan[] {
	if (text.length === 0) return [];
	const languages: string[] = lowlight.listLanguages();
	const cacheKey = `${language ?? ""}\n${text}`;
	const cached = cache.get(cacheKey);
	if (cached) return cached;
	const nodes =
		language &&
		(languages.includes(language) || lowlight.registered?.(language))
			? highlightResultNodes(lowlight.highlight(language, text))
			: highlightResultNodes(lowlight.highlightAuto(text));
	const spans = parseHighlightNodes(nodes);
	if (cache.size >= HIGHLIGHT_CACHE_LIMIT) cache.clear();
	cache.set(cacheKey, spans);
	return spans;
}

function decorateCodeBlocks(
	doc: ProseMirrorNode,
	name: string,
	lowlight: LowlightInstance,
	defaultLanguage: string | null | undefined,
	cache: Map<string, HighlightSpan[]>,
) {
	const decorations: Decoration[] = [];
	findChildren(doc, (node) => node.type.name === name).forEach((block) => {
		let from = block.pos + 1;
		const language = block.node.attrs.language || defaultLanguage;
		for (const span of cachedHighlightSpans(
			lowlight,
			cache,
			language,
			block.node.textContent,
		)) {
			if (span.text.length === 0) continue;
			const to = from + span.text.length;
			if (span.classes.length) {
				decorations.push(
					Decoration.inline(from, to, { class: span.classes.join(" ") }),
				);
			}
			from = to;
		}
	});
	return DecorationSet.create(doc, decorations);
}

/**
 * Single-plugin replacement for upstream `LowlightPlugin` with identical
 * decoration output: only blocks whose language/text changed re-run
 * `highlight`/`highlightAuto` (via `cache`); every other block reuses its
 * parsed spans. The docChanged gating mirrors upstream so language switches,
 * paste, and undo/redo all still recompute.
 */
function hubbleLowlightPlugin({
	name,
	lowlight,
	defaultLanguage,
}: {
	name: string;
	lowlight: LowlightInstance;
	defaultLanguage: string | null | undefined;
}) {
	const cache = new Map<string, HighlightSpan[]>();
	const plugin: Plugin<DecorationSet> = new Plugin<DecorationSet>({
		key: new PluginKey("lowlight"),
		state: {
			init: (_, { doc }) =>
				decorateCodeBlocks(doc, name, lowlight, defaultLanguage, cache),
			apply: (transaction, decorationSet, oldState, newState) => {
				// Selection-only and meta-only transactions never change a
				// block's text or language: map positions without walking
				// either document. (Upstream walks both docs first and reaches
				// the same mapped result; skipping the walks is the point.)
				if (!transaction.docChanged) {
					return decorationSet.map(transaction.mapping, transaction.doc);
				}
				const oldNodeName = oldState.selection.$head.parent.type.name;
				const newNodeName = newState.selection.$head.parent.type.name;
				const oldNodes = findChildren(
					oldState.doc,
					(node) => node.type.name === name,
				);
				const newNodes = findChildren(
					newState.doc,
					(node) => node.type.name === name,
				);
				if (
					oldNodeName === name ||
					newNodeName === name ||
					newNodes.length !== oldNodes.length ||
					transaction.steps.some((step) => {
						const from = (step as unknown as { from?: unknown }).from;
						const to = (step as unknown as { to?: unknown }).to;
						// Intersection (not just encapsulation): a programmatic
						// narrow edit strictly inside a block -- selection
						// elsewhere, e.g. find-replace or a collab step -- must
						// still invalidate that block. Over-triggering only
						// costs a cached rebuild; under-triggering leaves stale
						// decorations.
						return (
							typeof from === "number" &&
							typeof to === "number" &&
							oldNodes.some(
								(node) => from < node.pos + node.node.nodeSize && to > node.pos,
							)
						);
					})
				) {
					return decorateCodeBlocks(
						transaction.doc,
						name,
						lowlight,
						defaultLanguage,
						cache,
					);
				}
				return decorationSet.map(transaction.mapping, transaction.doc);
			},
		},
		props: {
			decorations(state) {
				return plugin.getState(state);
			},
		},
	});
	return plugin;
}

async function copyCodeBlock(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		// TODO: Revisit if UI grows a shared toast store; this bridges TipTap's node view to EditorView's onMessage without adding app state here.
		window.dispatchEvent(
			new CustomEvent(CODE_BLOCK_COPY_EVENT, {
				detail: { message: "Code copied", type: "success" },
			}),
		);
	} catch {
		window.dispatchEvent(
			new CustomEvent(CODE_BLOCK_COPY_EVENT, {
				detail: { message: "Failed to copy code", type: "error" },
			}),
		);
	}
}

const codeBlockLanguages = [
	{ value: "", label: "Plain text" },
	{ value: "js", label: "JavaScript" },
	{ value: "ts", label: "TypeScript" },
	{ value: "jsx", label: "JSX" },
	{ value: "tsx", label: "TSX" },
	{ value: "json", label: "JSON" },
	{ value: "css", label: "CSS" },
	{ value: "html", label: "HTML" },
	{ value: "md", label: "Markdown" },
	{ value: "sh", label: "Shell" },
	{ value: "python", label: "Python" },
	{ value: "rust", label: "Rust" },
	{ value: "go", label: "Go" },
] as const;
