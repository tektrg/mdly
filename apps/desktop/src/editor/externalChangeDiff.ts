/**
 * Computes ProseMirror inline + block-level suggestions for an already-applied
 * external Markdown edit (`previousContent` -> live `currDoc`).
 *
 * Strategy:
 * - Strip YAML frontmatter first (ProseMirror only renders the body). Report
 *   `frontMatterChanged` so the UI can note it / offer the raw diff fallback.
 * - Parse `previousContent` body through the same `markdownToTiptapDoc` +
 *   ProseMirror schema so blocks align 1:1 with the live editor document.
 * - Run an LCS diff over top-level blocks:
 *   - Unchanged blocks are skipped.
 *   - Purely added blocks -> `block-add` (green highlight; Undo deletes).
 *   - Purely removed blocks -> `block-del` (red ghost block; Undo restores).
 *   - Modified same-type textblocks (non-codeBlock) -> word-level `inline`
 *     changes via `wordChanges(newText, oldText)` (exact same UX as AI edits),
 *     or `block-replace` if only marks/attributes changed.
 *   - Modified matching container blocks (lists, blockquotes) with the same
 *     child count -> recurse into children so list-item edits stay word-level.
 *   - Other structural changes -> `block-replace` (red ghost + green highlight).
 */
import { wordChanges } from "@mdly/agent-hook/diff";
import {
	markdownToTiptapDoc,
	parseMarkdownFrontMatter,
} from "@mdly/workspace-kit";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import {
	newSuggestionId,
	type SuggestionChange,
	textOffsetToPos,
} from "./SuggestionExtension";

interface BlockEntry {
	node: ProseMirrorNode;
	from: number;
	to: number;
	key: string;
}

const EPHEMERAL_ATTRS = new Set(["uid"]);

/**
 * Strips session-only attributes (e.g. randomly minted table `uid`) so
 * structurally identical nodes compare equal across parses.
 */
function stripEphemeralAttrs(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripEphemeralAttrs);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (k === "attrs" && v && typeof v === "object") {
				const filtered: Record<string, unknown> = {};
				let hasAny = false;
				for (const [ak, av] of Object.entries(v as Record<string, unknown>)) {
					if (EPHEMERAL_ATTRS.has(ak)) continue;
					filtered[ak] = av;
					hasAny = true;
				}
				if (hasAny) out[k] = filtered;
			} else {
				out[k] = stripEphemeralAttrs(v);
			}
		}
		return out;
	}
	return value;
}

function semanticNodeKey(node: ProseMirrorNode): string {
	return JSON.stringify(stripEphemeralAttrs(node.toJSON()));
}

function collectChildren(
	parent: ProseMirrorNode,
	startOffset: number,
): BlockEntry[] {
	const entries: BlockEntry[] = [];
	let pos = startOffset;
	parent.forEach((child) => {
		const from = pos;
		const to = pos + child.nodeSize;
		entries.push({
			node: child,
			from,
			to,
			key: semanticNodeKey(child),
		});
		pos = to;
	});
	return entries;
}

type DiffOp =
	| { kind: "equal"; oldIndex: number; newIndex: number }
	| { kind: "delete"; oldIndex: number }
	| { kind: "insert"; newIndex: number };

/**
 * Standard DP LCS diff over block keys. Documents typically have dozens to a
 * few hundred top-level blocks; trim common prefix/suffix first so typical
 * localized edits run in O(1) DP space.
 */
function diffKeys(oldKeys: string[], newKeys: string[]): DiffOp[] {
	const ops: DiffOp[] = [];
	let start = 0;
	let oldEnd = oldKeys.length;
	let newEnd = newKeys.length;

	while (
		start < oldEnd &&
		start < newEnd &&
		oldKeys[start] === newKeys[start]
	) {
		ops.push({ kind: "equal", oldIndex: start, newIndex: start });
		start++;
	}
	const suffix: DiffOp[] = [];
	while (
		oldEnd > start &&
		newEnd > start &&
		oldKeys[oldEnd - 1] === newKeys[newEnd - 1]
	) {
		oldEnd--;
		newEnd--;
		suffix.push({ kind: "equal", oldIndex: oldEnd, newIndex: newEnd });
	}
	suffix.reverse();

	const m = oldEnd - start;
	const n = newEnd - start;

	if (m === 0) {
		for (let j = 0; j < n; j++)
			ops.push({ kind: "insert", newIndex: start + j });
		return [...ops, ...suffix];
	}
	if (n === 0) {
		for (let i = 0; i < m; i++)
			ops.push({ kind: "delete", oldIndex: start + i });
		return [...ops, ...suffix];
	}

	// Guard against pathological huge-doc quadratic DP: fall back to a single
	// replace hunk if the differing middle exceeds 250k cells.
	if (m * n > 250_000) {
		for (let i = 0; i < m; i++)
			ops.push({ kind: "delete", oldIndex: start + i });
		for (let j = 0; j < n; j++)
			ops.push({ kind: "insert", newIndex: start + j });
		return [...ops, ...suffix];
	}

	const dp = new Uint32Array((m + 1) * (n + 1));
	const stride = n + 1;
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			if (oldKeys[start + i] === newKeys[start + j]) {
				dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1;
			} else {
				const down = dp[(i + 1) * stride + j];
				const right = dp[i * stride + (j + 1)];
				dp[i * stride + j] = down >= right ? down : right;
			}
		}
	}

	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (oldKeys[start + i] === newKeys[start + j]) {
			ops.push({ kind: "equal", oldIndex: start + i, newIndex: start + j });
			i++;
			j++;
		} else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
			ops.push({ kind: "delete", oldIndex: start + i });
			i++;
		} else {
			ops.push({ kind: "insert", newIndex: start + j });
			j++;
		}
	}
	while (i < m) {
		ops.push({ kind: "delete", oldIndex: start + i });
		i++;
	}
	while (j < n) {
		ops.push({ kind: "insert", newIndex: start + j });
		j++;
	}

	return [...ops, ...suffix];
}

function previewText(nodes: ProseMirrorNode[]): string {
	return nodes
		.map((n) => {
			if (n.type.name === "table") {
				const rows: string[] = [];
				n.forEach((row) => {
					const cells: string[] = [];
					row.forEach((cell) => {
						cells.push(cell.textContent.trim());
					});
					rows.push(cells.join(" | "));
				});
				return rows.join("\n") || "[table]";
			}
			if (n.type.name === "tableRow") {
				const cells: string[] = [];
				n.forEach((cell) => {
					cells.push(cell.textContent.trim());
				});
				return cells.join(" | ") || "[row]";
			}
			return n.textContent.trim() || `[${n.type.name}]`;
		})
		.join("\n");
}

function isSameTextblockShape(a: ProseMirrorNode, b: ProseMirrorNode): boolean {
	if (!a.isTextblock || !b.isTextblock) return false;
	if (a.type !== b.type) return false;
	if (a.type.name === "codeBlock") return false;
	// Heading level or other block attrs changed -> show as block replace.
	return JSON.stringify(a.attrs) === JSON.stringify(b.attrs);
}

function isRecursableContainer(
	a: ProseMirrorNode,
	b: ProseMirrorNode,
): boolean {
	if (a.isTextblock || b.isTextblock) return false;
	if (a.type !== b.type) return false;
	if (a.childCount === 0 || b.childCount === 0) return false;
	if (a.type.name === "table") {
		// Recurse into table rows only when column count is unchanged; column
		// additions/removals fall back to a formatted table block-replace.
		return (a.firstChild?.childCount ?? 0) === (b.firstChild?.childCount ?? 0);
	}
	if (a.type.name === "tableRow") {
		return a.childCount === b.childCount;
	}
	return true;
}

function diffPairedBlock(
	oldBlock: BlockEntry,
	newBlock: BlockEntry,
	groupId: string,
	out: SuggestionChange[],
) {
	if (oldBlock.key === newBlock.key) return;

	if (isSameTextblockShape(oldBlock.node, newBlock.node)) {
		const oldText = oldBlock.node.textContent;
		const newText = newBlock.node.textContent;
		// wordChanges(newText, oldText) gives [start, end) offsets in `newText`
		// (which is what lives in currDoc), with `before` = added text in newText
		// and `after` = removed text from oldText.
		const changes = wordChanges(newText, oldText);
		if (changes.length > 0) {
			for (const c of changes) {
				out.push({
					id: newSuggestionId(),
					groupId,
					source: "external",
					applied: true,
					kind: "inline",
					from: textOffsetToPos(newBlock.node, newBlock.from, c.start),
					to: textOffsetToPos(newBlock.node, newBlock.from, c.end),
					before: c.after,
					insert: c.before,
				});
			}
			return;
		}
		// Plain text is identical, so only inline marks (bold/link/code) changed.
		out.push({
			id: newSuggestionId(),
			groupId,
			source: "external",
			applied: true,
			kind: "block-replace",
			from: newBlock.from,
			to: newBlock.to,
			before: oldText,
			insert: newText,
			deletedNodes: [oldBlock.node],
		});
		return;
	}

	if (isRecursableContainer(oldBlock.node, newBlock.node)) {
		diffBlockLists(
			collectChildren(oldBlock.node, oldBlock.from + 1),
			collectChildren(newBlock.node, newBlock.from + 1),
			newBlock.to - 1,
			groupId,
			out,
		);
		return;
	}

	out.push({
		id: newSuggestionId(),
		groupId,
		source: "external",
		applied: true,
		kind: "block-replace",
		from: newBlock.from,
		to: newBlock.to,
		before: previewText([oldBlock.node]),
		insert: previewText([newBlock.node]),
		deletedNodes: [oldBlock.node],
	});
}

function diffBlockLists(
	oldBlocks: BlockEntry[],
	newBlocks: BlockEntry[],
	endPos: number,
	groupId: string,
	out: SuggestionChange[],
) {
	const ops = diffKeys(
		oldBlocks.map((b) => b.key),
		newBlocks.map((b) => b.key),
	);

	let idx = 0;
	while (idx < ops.length) {
		const op = ops[idx];
		if (op.kind === "equal") {
			idx++;
			continue;
		}
		const removed: BlockEntry[] = [];
		const added: BlockEntry[] = [];
		while (idx < ops.length && ops[idx].kind !== "equal") {
			const cur = ops[idx];
			if (cur.kind === "delete") removed.push(oldBlocks[cur.oldIndex]);
			else if (cur.kind === "insert") added.push(newBlocks[cur.newIndex]);
			idx++;
		}

		// Position in the live document where this hunk lives (used for pure deletions).
		const nextEqual = ops[idx];
		const anchorPos =
			nextEqual && nextEqual.kind === "equal"
				? newBlocks[nextEqual.newIndex].from
				: endPos;

		if (removed.length === 0) {
			for (const block of added) {
				out.push({
					id: newSuggestionId(),
					groupId,
					source: "external",
					applied: true,
					kind: "block-add",
					from: block.from,
					to: block.to,
					before: "",
					insert: previewText([block.node]),
				});
			}
			continue;
		}

		if (added.length === 0) {
			// Emit deleted table rows individually so each renders as its own <tr>
			// inside <tbody> with aligned columns.
			if (removed.every((b) => b.node.type.name === "tableRow")) {
				for (const block of removed) {
					out.push({
						id: newSuggestionId(),
						groupId,
						source: "external",
						applied: true,
						kind: "block-del",
						from: anchorPos,
						to: anchorPos,
						before: previewText([block.node]),
						insert: "",
						deletedNodes: [block.node],
					});
				}
				continue;
			}
			out.push({
				id: newSuggestionId(),
				groupId,
				source: "external",
				applied: true,
				kind: "block-del",
				from: anchorPos,
				to: anchorPos,
				before: previewText(removed.map((b) => b.node)),
				insert: "",
				deletedNodes: removed.map((b) => b.node),
			});
			continue;
		}

		const paired = Math.min(removed.length, added.length);
		for (let k = 0; k < paired; k++) {
			diffPairedBlock(removed[k], added[k], groupId, out);
		}
		if (added.length > paired) {
			for (let k = paired; k < added.length; k++) {
				const block = added[k];
				out.push({
					id: newSuggestionId(),
					groupId,
					source: "external",
					applied: true,
					kind: "block-add",
					from: block.from,
					to: block.to,
					before: "",
					insert: previewText([block.node]),
				});
			}
		}
		if (removed.length > paired) {
			const leftover = removed.slice(paired);
			const delPos = added[paired - 1]?.to ?? anchorPos;
			out.push({
				id: newSuggestionId(),
				groupId,
				source: "external",
				applied: true,
				kind: "block-del",
				from: delPos,
				to: delPos,
				before: previewText(leftover.map((b) => b.node)),
				insert: "",
				deletedNodes: leftover.map((b) => b.node),
			});
		}
	}
}

/** Diffs two ProseMirror docs and returns already-applied external suggestions. */
export function diffExternalDocs(
	prevDoc: ProseMirrorNode,
	currDoc: ProseMirrorNode,
	groupId: string,
): SuggestionChange[] {
	const out: SuggestionChange[] = [];
	diffBlockLists(
		collectChildren(prevDoc, 0),
		collectChildren(currDoc, 0),
		currDoc.content.size,
		groupId,
		out,
	);
	return out;
}

export interface ExternalChangeDiffResult {
	changes: SuggestionChange[];
	frontMatterChanged: boolean;
}

/**
 * Parses `previousMarkdown` into the same TipTap/ProseMirror schema as
 * `currDoc` and builds inline + block-level suggestions for every difference.
 */
export function buildExternalChangeSuggestions(
	previousMarkdown: string,
	currentMarkdown: string,
	currDoc: ProseMirrorNode,
	schema: Schema,
	groupId: string,
): ExternalChangeDiffResult {
	const prevParsed = parseMarkdownFrontMatter(previousMarkdown);
	const currParsed = parseMarkdownFrontMatter(currentMarkdown);
	const prevRawFm = prevParsed.type === "none" ? "" : prevParsed.raw;
	const currRawFm = currParsed.type === "none" ? "" : currParsed.raw;
	const frontMatterChanged = prevRawFm !== currRawFm;

	try {
		const prevBody = prevParsed.body;
		const prevDoc = schema.nodeFromJSON(markdownToTiptapDoc(prevBody));
		const changes = diffExternalDocs(prevDoc, currDoc, groupId);
		return { changes, frontMatterChanged };
	} catch {
		return { changes: [], frontMatterChanged };
	}
}
