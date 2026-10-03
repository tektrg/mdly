// @vitest-environment happy-dom
import { act, useRef } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useFlipOnChange } from "./useResponsiveRowLayout";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const animate = vi.fn(() => ({ onfinish: null, oncancel: null }));
HTMLElement.prototype.animate = animate as unknown as HTMLElement["animate"];

function List({ tier }: { tier: string }) {
	const ref = useRef<HTMLDivElement | null>(null);
	useFlipOnChange(ref, tier);
	return (
		<div ref={ref}>
			<span data-flip-id="a::name">a</span>
			{tier === "list" ? <span data-flip-id="a::modified">x</span> : null}
		</div>
	);
}

describe("useFlipOnChange", () => {
	it("animates only when the key changes", () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		act(() => root.render(<List tier="rail" />));
		act(() => root.render(<List tier="rail" />));
		expect(animate).not.toHaveBeenCalled();
		// rail -> list: the new secondary cell fades in.
		act(() => root.render(<List tier="list" />));
		expect(animate).toHaveBeenCalledTimes(1);
		// list -> rail: the secondary cell fades out as a ghost.
		act(() => root.render(<List tier="rail" />));
		expect(animate).toHaveBeenCalledTimes(2);
		act(() => root.unmount());
	});
});
