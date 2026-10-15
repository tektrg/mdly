// @vitest-environment happy-dom
import { act, createRef } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { SidebarPager } from "./SidebarPager";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("SidebarPager", () => {
	it("snaps the swipe region back to 0 if something scrolls it sideways", () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const pages = ["a", "b", "c"].map((id) => ({
			id,
			label: id,
			icon: null,
			navRef: createRef<HTMLElement>(),
			content: id,
		}));
		act(() => {
			root.render(
				<SidebarPager pages={pages} activePage={1} onPageChange={() => {}} />,
			);
		});
		const region = container.querySelector(
			"[data-sidebar-swipe-region]",
		) as HTMLElement;
		region.scrollLeft = 300;
		act(() => {
			region.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		expect(region.scrollLeft).toBe(0);
		act(() => root.unmount());
		container.remove();
	});
});
