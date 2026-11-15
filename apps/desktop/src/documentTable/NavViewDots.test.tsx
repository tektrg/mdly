// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavViewDots } from "./NavViewDots";
import { builtInEntries, type NavSwitcherEntry } from "./navSwitcherEntries";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const entries: NavSwitcherEntry[] = [
	...builtInEntries(["recent", "folder", "tag"]),
	...Array.from(
		{ length: 9 },
		(_, i): NavSwitcherEntry => ({
			key: `saved:v${i}`,
			kind: "saved",
			id: `v${i}`,
			name: `View ${i}`,
		}),
	),
];

describe("NavViewDots overflow", () => {
	let container: HTMLDivElement;
	let root: Root;
	const scrollIntoView = vi.fn();

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		scrollIntoView.mockClear();
		Element.prototype.scrollIntoView = scrollIntoView;
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
	});

	function renderDots(active: NavSwitcherEntry["key"] | null) {
		act(() => {
			root.render(
				<NavViewDots
					entries={entries}
					active={active}
					onSelect={vi.fn()}
					onToggleHidden={vi.fn()}
					onSavedViewMenu={vi.fn()}
					onWheel={vi.fn()}
				/>,
			);
		});
		return container.querySelector<HTMLElement>("[data-nav-view-dots]");
	}

	it("shrinks and scrolls instead of spilling past its slot", () => {
		const strip = renderDots("recent");
		expect(strip?.className).toContain("min-w-0");
		expect(strip?.className).toContain("flex-1");
		expect(strip?.className).toContain("overflow-x-auto");
		expect(strip?.className).not.toContain("shrink-0");
		// Dots keep their size; the strip scrolls rather than squeezing them.
		const dot = container.querySelector("[data-nav-view-dot]");
		expect(dot?.className).toContain("shrink-0");
	});

	it("fades the edges only while the dots overflow", () => {
		vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(300);
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(120);
		const strip = renderDots("recent");
		expect(strip?.hasAttribute("data-overflowing")).toBe(true);
		expect(strip?.className).toContain("mask-image");
	});

	it("does not fade when everything fits", () => {
		vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(100);
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(120);
		const strip = renderDots("recent");
		expect(strip?.hasAttribute("data-overflowing")).toBe(false);
		expect(strip?.className).not.toContain("mask-image");
	});

	it("brings the active dot into view", () => {
		renderDots("saved:v8");
		expect(scrollIntoView).toHaveBeenCalled();
		const target = scrollIntoView.mock.contexts[
			scrollIntoView.mock.contexts.length - 1
		] as HTMLElement;
		expect(target.getAttribute("data-nav-view-dot")).toBe("saved:v8");
	});
});
