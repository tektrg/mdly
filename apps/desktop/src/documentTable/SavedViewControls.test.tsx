// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspacePathStore } from "../store/state";
import { SaveViewButton } from "./properties/PropertyViewBar";
import { SavedViewNameInput } from "./SavedViewControls";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("saved view name box", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		document.body.innerHTML = "";
	});

	const input = () =>
		container.querySelector<HTMLInputElement>('input[aria-label="View name"]');

	async function type(value: string) {
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input(), value);
			input()?.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	it("blur commits a valid name", async () => {
		const onCommit = vi.fn(() => ({ ok: true as const, name: "New" }));
		const onCancel = vi.fn();
		act(() =>
			root.render(
				<SavedViewNameInput
					initialName="Old"
					onCommit={onCommit}
					onCancel={onCancel}
				/>,
			),
		);
		await type("New");
		await act(async () => {
			input()?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		expect(onCommit).toHaveBeenCalledWith("New");
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("blur with an invalid name cancels", async () => {
		const onCommit = vi.fn(() => ({ ok: false as const, reason: "empty" as const }));
		const onCancel = vi.fn();
		act(() =>
			root.render(
				<SavedViewNameInput initialName="" onCommit={onCommit} onCancel={onCancel} />,
			),
		);
		await act(async () => {
			input()?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		expect(onCancel).toHaveBeenCalled();
	});

	it("fills the row when asked (rail rename)", () => {
		act(() =>
			root.render(
				<SavedViewNameInput
					fill
					initialName="A"
					onCommit={() => ({ ok: true, name: "A" })}
					onCancel={() => {}}
				/>,
			),
		);
		expect(input()?.className).toContain("w-full");
		expect(input()?.className).not.toContain("w-40");
	});

	it("Save view with no workspace shows a generic error, not 'can't be empty'", async () => {
		workspacePathStore.set(null);
		act(() => root.render(<SaveViewButton canSave />));
		await act(async () => {
			container.querySelector("button")?.click();
		});
		await type("Fine name");
		await act(async () => {
			input()?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		const alert = container.querySelector('[role="alert"]')?.textContent;
		expect(alert).toBeTruthy();
		expect(alert).not.toContain("empty");
	});
});
