import { mergeAttributes, Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * Attribute marking the NodeView-owned overlay mount: an empty,
 * `contenteditable="false"` sibling of the `<table>` inside the
 * `.tableWrapper` scroll box. Slice 1 portals its dot overlay into this
 * element instead of the wrapper itself, so ProseMirror's DOMObserver — via
 * the NodeView's `ignoreMutation` below — agrees to leave the portal alone.
 * Inert chrome: no behaviour, no listeners, no measurement.
 */
export const TABLE_OVERLAY_MOUNT_ATTR = "data-table-overlay-mount";

function tableUidOf(node: PMNode): string {
	const uid = (node.attrs as { uid?: unknown }).uid;
	return typeof uid === "string" ? uid : "";
}

const tableCellAttributes = {
	align: {
		default: null,
		parseHTML: (element: HTMLElement) => element.getAttribute("align"),
		renderHTML: (attributes: { align?: string | null }) => {
			if (!attributes.align) return {};
			return { align: attributes.align };
		},
	},
};

export const TableExtension = Node.create({
	name: "table",
	group: "block",
	content: "tableRow+",
	isolating: true,

	addAttributes() {
		return {
			// Session-only per-table identity minted at parse time (ruling D3 /
			// charter R24). `rendered: false` keeps it out of the rendered DOM and
			// therefore out of clipboard HTML; the Markdown serializer reads only
			// `align`, so it never reaches the file either.
			uid: {
				default: null,
				rendered: false,
			},
		};
	},

	parseHTML() {
		return [{ tag: "table" }];
	},

	renderHTML({ HTMLAttributes }) {
		// Wrapped so a table wider than the editor column scrolls on its own
		// axis, instead of forcing the whole document to scroll sideways.
		// NOTE: this stays the serialization path (clipboard HTML, getHTML).
		// The editor view itself renders through `addNodeView` below, which
		// builds the same wrapper/table shape plus an overlay mount.
		return [
			"div",
			{ class: "tableWrapper" },
			["table", mergeAttributes(HTMLAttributes), ["tbody", 0]],
		];
	},

	addNodeView() {
		return ({ node, HTMLAttributes }) => {
			// The wrapper is the scroll box the dot overlay anchors into
			// (charter R36); the `<tbody>` is ProseMirror's content root so
			// rows render as valid table HTML. The mount is inert chrome —
			// an empty `contenteditable="false"` sibling of the table that
			// slice 1 portals into. A portal straight into PM-managed DOM is
			// repaired away within a frame; a portal into this mount survives
			// because `ignoreMutation` below agrees to leave it alone.
			const wrapper = document.createElement("div");
			wrapper.classList.add("tableWrapper");
			const table = document.createElement("table");
			for (const [key, value] of Object.entries(HTMLAttributes ?? {})) {
				if (value === null || value === undefined) continue;
				table.setAttribute(key, String(value));
			}
			const tbody = document.createElement("tbody");
			table.appendChild(tbody);
			const mount = document.createElement("div");
			mount.setAttribute(TABLE_OVERLAY_MOUNT_ATTR, tableUidOf(node));
			mount.setAttribute("contenteditable", "false");
			wrapper.appendChild(table);
			wrapper.appendChild(mount);
			return {
				dom: wrapper,
				contentDOM: tbody,
				// Same table type edits (typing in a cell, row/column moves)
				// reuse this wrapper in place, so the overlay portal never
				// remounts. Anything else tears the view down honestly.
				update: (updatedNode) => {
					if (updatedNode.type.name !== "table") return false;
					mount.setAttribute(TABLE_OVERLAY_MOUNT_ATTR, tableUidOf(updatedNode));
					return true;
				},
				// Raw ProseMirror views ignore nothing by default, so say it
				// explicitly: only the `<tbody>` subtree and selection reads
				// are document state. Dots, the menu, the expand control and
				// wrapper/table chrome (e.g. full-width class flips) are never
				// document state, so observer flushes leave them alone.
				ignoreMutation: (mutation) => {
					if (mutation.type === "selection") return false;
					if (tbody.contains(mutation.target)) return false;
					return true;
				},
				// Dots, the Delete menu and the expand control are chrome, not
				// content: the editor's own pointer handling never sees them
				// (charter R14 — no editor drag, drop, or margin-click-to-end
				// starts from a handle press).
				stopEvent: (event) => {
					const target = event.target;
					return target instanceof globalThis.Node && mount.contains(target);
				},
			};
		};
	},
});

export const TableRowExtension = Node.create({
	name: "tableRow",
	content: "(tableCell | tableHeader)*",

	parseHTML() {
		return [{ tag: "tr" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["tr", mergeAttributes(HTMLAttributes), 0];
	},
});

export const TableCellExtension = Node.create({
	name: "tableCell",
	content: "block+",
	isolating: true,
	addAttributes() {
		return tableCellAttributes;
	},

	parseHTML() {
		return [{ tag: "td" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["td", mergeAttributes(HTMLAttributes), 0];
	},
});

export const TableHeaderExtension = Node.create({
	name: "tableHeader",
	content: "block+",
	isolating: true,
	addAttributes() {
		return tableCellAttributes;
	},

	parseHTML() {
		return [{ tag: "th" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["th", mergeAttributes(HTMLAttributes), 0];
	},
});

export const tableExtensions = [
	TableExtension,
	TableRowExtension,
	TableCellExtension,
	TableHeaderExtension,
];
