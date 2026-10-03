// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { playFlip, snapshotFlipRects } from "./useResponsiveRowLayout";

function rect(left: number, top: number): DOMRect {
	return {
		left,
		top,
		width: 40,
		height: 16,
		right: left + 40,
		bottom: top + 16,
		x: left,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

function cell(id: string, at: DOMRect): HTMLElement {
	const node = document.createElement("span");
	node.dataset.flipId = id;
	node.textContent = id;
	node.getBoundingClientRect = () => at;
	return node;
}

describe("snapshotFlipRects + playFlip", () => {
	const animate = vi.fn(() => ({ onfinish: null, oncancel: null }));

	afterEach(() => {
		animate.mockClear();
		document.body.innerHTML = "";
	});

	function mount(...cells: HTMLElement[]): HTMLElement {
		const root = document.createElement("div");
		root.animate = animate as unknown as HTMLElement["animate"];
		for (const node of cells) {
			node.animate = animate as unknown as HTMLElement["animate"];
			root.append(node);
		}
		document.body.append(root);
		return root;
	}

	it("glides kept cells, fades in new ones, ghosts removed ones out", () => {
		const root = mount(
			cell("a:date", rect(100, 20)),
			cell("a:gone", rect(0, 0)),
		);
		const before = snapshotFlipRects(root);

		root.innerHTML = "";
		const moved = cell("a:date", rect(300, 10));
		const added = cell("a:extra", rect(400, 10));
		for (const node of [moved, added]) {
			node.animate = animate as unknown as HTMLElement["animate"];
			root.append(node);
		}
		const realAnimate = HTMLElement.prototype.animate;
		HTMLElement.prototype.animate =
			animate as unknown as HTMLElement["animate"];
		try {
			playFlip(root, before);
		} finally {
			HTMLElement.prototype.animate = realAnimate;
		}

		const calls = animate.mock.calls as unknown as [
			Keyframe[],
			KeyframeAnimationOptions,
		][];
		const glide = calls.find(([frames]) => "transform" in frames[0]);
		expect(glide?.[0][0].transform).toBe("translate(-200px, 10px)");
		expect(glide?.[0][glide[0].length - 1]?.transform).toBe(
			"translate(0px, 0px)",
		);
		expect(glide?.[1].duration).toBe(170);

		const fades = calls.filter(([frames]) => "opacity" in frames[0]);
		expect(fades.some(([f]) => f[0].opacity === 0)).toBe(true);
		expect(fades.some(([f]) => f[0].opacity === 1 && f[1].opacity === 0)).toBe(
			true,
		);

		const ghost = Array.from(document.body.children).find(
			(node) => node.textContent === "a:gone",
		) as HTMLElement | undefined;
		expect(ghost?.style.position).toBe("fixed");
		expect(ghost?.hasAttribute("data-flip-id")).toBe(false);
	});

	it("does nothing under prefers-reduced-motion", () => {
		const root = mount(cell("a:date", rect(0, 0)));
		const before = snapshotFlipRects(root);
		const real = window.matchMedia;
		window.matchMedia = ((query: string) => ({
			matches: query.includes("reduce"),
		})) as unknown as typeof window.matchMedia;
		try {
			root.innerHTML = "";
			root.append(cell("a:date", rect(200, 0)));
			playFlip(root, before);
		} finally {
			window.matchMedia = real;
		}
		expect(animate).not.toHaveBeenCalled();
	});
});
