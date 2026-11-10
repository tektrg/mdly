// @vitest-environment happy-dom
import { isMac } from "keymatch";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentFilterInput } from "./DocumentFilterInput";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("filter box Cmd/Ctrl+L", () => {
	const mod = isMac() ? { metaKey: true } : { ctrlKey: true };
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		act(() =>
			root.render(<DocumentFilterInput value="abc" onChange={() => {}} />),
		);
	});

	afterEach(() => {
		act(() => root.unmount());
		document.body.innerHTML = "";
	});

	const input = () =>
		container.querySelector<HTMLInputElement>(
			'input[aria-label="Filter documents"]',
		) as HTMLInputElement;

	function press(init: KeyboardEventInit) {
		const event = new KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			...init,
		});
		act(() => {
			document.body.dispatchEvent(event);
		});
		return event;
	}

	it("focuses and selects the box from anywhere", () => {
		const event = press({ key: "l", ...mod });
		expect(document.activeElement).toBe(input());
		expect(input().selectionStart).toBe(0);
		expect(input().selectionEnd).toBe(3);
		expect(event.defaultPrevented).toBe(true);
	});

	it("ignores plain L and stops listening after unmount", () => {
		press({ key: "l" });
		expect(document.activeElement).not.toBe(input());
		act(() => root.unmount());
		const event = press({ key: "l", ...mod });
		expect(event.defaultPrevented).toBe(false);
		root = createRoot(container);
	});
});
