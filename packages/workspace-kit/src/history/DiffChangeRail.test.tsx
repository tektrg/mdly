// @vitest-environment happy-dom
import type { ChangeGroup } from "@mdly/doc-history";
import { act, useRef } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffChangeRail } from "./DiffChangeRail";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

Element.prototype.scrollIntoView = vi.fn();

const GROUPS: ChangeGroup[] = [
	{ kind: "unchanged", id: "group-0", value: "before" },
	{ kind: "changed", id: "group-1", oldText: "old", newText: "new" },
	{ kind: "unchanged", id: "group-2", value: "between" },
	{ kind: "changed", id: "group-3", oldText: "old2", newText: "new2" },
];

function Harness({ groups }: { groups: ChangeGroup[] }) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	return (
		<div>
			<div ref={containerRef} data-testid="diff-body">
				{groups.map((group) => (
					<div key={group.id} data-region-id={group.id}>
						{group.kind === "unchanged" ? group.value : group.newText}
					</div>
				))}
			</div>
			<DiffChangeRail groups={groups} containerRef={containerRef} />
		</div>
	);
}

describe("DiffChangeRail", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it("renders one dash per changed group", () => {
		act(() => {
			root.render(<Harness groups={GROUPS} />);
		});

		expect(container.querySelectorAll(".diffChangeRailDash")).toHaveLength(2);
	});

	it("renders nothing when there are no changed groups", () => {
		act(() => {
			root.render(
				<Harness groups={[{ kind: "unchanged", id: "group-0", value: "x" }]} />,
			);
		});

		expect(container.querySelector(".diffChangeRail")).toBeNull();
	});

	it("scrolls the matching region into view when its dash is clicked", () => {
		act(() => {
			root.render(<Harness groups={GROUPS} />);
		});

		const dashes = container.querySelectorAll<HTMLButtonElement>(
			".diffChangeRailDash",
		);
		act(() => dashes[1]?.click());

		const target = container.querySelector('[data-region-id="group-3"]');
		expect(target?.scrollIntoView).toHaveBeenCalledWith({
			block: "start",
			behavior: "smooth",
		});
	});
});
