import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { readTableShape } from "../tableTransforms.js";
import type { TableTarget } from "./tableInteractionTypes.js";

/**
 * One discovered table plus the dot counts the overlay needs. Counts are
 * document facts, not pixel geometry — holding them in React state is fine
 * (charter R35 only bans geometry in state).
 */
export type TableHandleTarget = TableTarget & {
	columnCount: number;
	bodyRowCount: number;
};

export type TableTargetSnapshot = {
	targets: TableHandleTarget[];
	/** Bumps on every committed rescan so hovered dots can re-place themselves. */
	rescanEpoch: number;
};

const NESTED_TABLE_TYPES = new Set([
	"table",
	"tableRow",
	"tableCell",
	"tableHeader",
]);

function requestRescanFrame(callback: () => void): () => void {
	if (typeof requestAnimationFrame === "function") {
		const id = requestAnimationFrame(callback);
		return () => cancelAnimationFrame(id);
	}
	const id = window.setTimeout(callback, 0);
	return () => window.clearTimeout(id);
}

/**
 * Find every GFM table node currently rendered (charter R16: never a nested
 * table inside a cell — when the target is ambiguous this draws nothing for
 * that table rather than acting on the wrong one).
 */
export function collectTableTargets(editor: Editor): TableHandleTarget[] {
	const targets: TableHandleTarget[] = [];
	const { doc } = editor.state;
	doc.descendants((node, pos) => {
		if (node.type.name !== "table") return true;
		try {
			const $pos = doc.resolve(pos);
			for (let depth = 0; depth <= $pos.depth; depth += 1) {
				const ancestor = $pos.node(depth);
				if (ancestor !== node && NESTED_TABLE_TYPES.has(ancestor.type.name)) {
					return false;
				}
			}
		} catch {
			return false;
		}
		const uid = (node.attrs as { uid?: unknown }).uid;
		if (typeof uid !== "string" || uid.length === 0) return false;
		let dom: unknown;
		try {
			dom = editor.view.nodeDOM(pos);
		} catch {
			return false;
		}
		if (!(dom instanceof HTMLElement)) return false;
		const wrapperEl = dom.classList.contains("tableWrapper")
			? dom
			: dom.querySelector(".tableWrapper");
		if (!(wrapperEl instanceof HTMLElement)) return false;
		// The view can hand back a wrapper it has already torn down (a
		// NodeView destroyed ahead of its replacement, or a rescan racing
		// the view's own attach on mount). Portalling into detached DOM
		// renders an invisible overlay that later rescans keep mistaking
		// for a healthy one, so only attached wrappers become targets.
		if (!wrapperEl.isConnected) return false;
		const tableEl = wrapperEl.querySelector("table");
		if (!(tableEl instanceof HTMLTableElement)) return false;
		// The wrapper must own exactly this table, and the table must not sit
		// inside a cell (rich-HTML paste can nest a table in a td).
		if (tableEl.closest(".tableWrapper") !== wrapperEl) return false;
		if (tableEl.closest("td, th")) return false;
		let shape: { columnCount: number; bodyRowCount: number };
		try {
			shape = readTableShape(node.toJSON());
		} catch {
			return false;
		}
		if (shape.columnCount <= 0) return false;
		targets.push({
			uid,
			pos,
			tableEl,
			wrapperEl,
			columnCount: shape.columnCount,
			bodyRowCount: shape.bodyRowCount,
		});
		return false;
	});
	return targets;
}

/**
 * DocChanged-gated, rAF-coalesced table discovery (charter R34 / R37).
 *
 * The rescan runs synchronously once on mount and afterwards only inside a
 * `transaction` listener that ignores anything with `docChanged === false`
 * — caret moves and plugin-meta echoes never reach layout — with at most one
 * rescan per animation frame no matter how large the change burst is. The
 * targets array keeps its identity when the table set is unchanged, so a
 * rescan that finds nothing new re-renders nothing.
 */
export function useTableTargets(editor: Editor | null): TableTargetSnapshot {
	const [snapshot, setSnapshot] = useState<TableTargetSnapshot>({
		targets: [],
		rescanEpoch: 0,
	});

	useEffect(() => {
		if (!editor) {
			setSnapshot({ targets: [], rescanEpoch: 0 });
			return;
		}
		let disposed = false;
		let frameScheduled = false;
		let cancelFrame: (() => void) | null = null;

		const rescan = () => {
			frameScheduled = false;
			cancelFrame = null;
			if (disposed) return;
			let targets: TableHandleTarget[];
			try {
				targets = collectTableTargets(editor);
			} catch {
				return;
			}
			const key = targets.map(
				(target) =>
					`${target.uid}@${target.pos}:${target.columnCount}/${target.bodyRowCount}`,
			);
			setSnapshot((previous) => {
				const previousKey = previous.targets.map(
					(target) =>
						`${target.uid}@${target.pos}:${target.columnCount}/${target.bodyRowCount}`,
				);
				const unchanged =
					previousKey.length === key.length &&
					previousKey.every((entry, index) => entry === key[index]) &&
					// Same document facts can still ride on replaced DOM:
					// ProseMirror may destroy and recreate a table's NodeView
					// (same uid, same pos, same shape) while the overlay
					// portal is still mounted in the torn-down wrapper. The
					// portal would go invisible and stay that way, so a DOM
					// swap always counts as changed and remarries the portal
					// to the live wrapper.
					previous.targets.every(
						(previousTarget, index) =>
							previousTarget.wrapperEl === targets[index]?.wrapperEl,
					);
				// The epoch bumps on every committed rescan (one per frame max)
				// so hovered dots re-place themselves after typing inside the
				// table; the targets array keeps its identity when the table
				// set is unchanged so portals never remount for no reason.
				// The shape rides in the key: a same-position shape edit (a
				// column Delete) must hand the overlay fresh dot counts, or
				// the dots recount never happens.
				if (unchanged) {
					return {
						targets: previous.targets,
						rescanEpoch: previous.rescanEpoch + 1,
					};
				}
				return { targets, rescanEpoch: previous.rescanEpoch + 1 };
			});
		};

		const scheduleRescan = () => {
			if (frameScheduled || disposed) return;
			frameScheduled = true;
			cancelFrame = requestRescanFrame(rescan);
		};

		// Synchronous first pass so dots exist on first paint (and in tests),
		// plus one frame-deferred pass: the view's own DOM may not be
		// attached yet when this effect runs (sibling attach order), in
		// which case the first pass legitimately finds nothing and the
		// deferred pass heals it once layout has settled.
		rescan();
		scheduleRescan();

		const onTransaction = (event?: {
			transaction?: { docChanged?: boolean };
		}) => {
			if (event?.transaction && event.transaction.docChanged === false) {
				return;
			}
			scheduleRescan();
		};

		editor.on("transaction", onTransaction);
		return () => {
			disposed = true;
			cancelFrame?.();
			editor.off("transaction", onTransaction);
		};
	}, [editor]);

	return snapshot;
}
