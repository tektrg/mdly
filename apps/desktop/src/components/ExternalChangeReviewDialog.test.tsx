// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalChangeReviewDialog } from "./ExternalChangeReviewDialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@hubble.md/ui", () => ({
	Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
		open ? <div data-testid="modal">{children}</div> : null,
	Button: ({
		children,
		onClick,
	}: {
		children: ReactNode;
		onClick?: () => void;
	}) => (
		<button type="button" onClick={onClick}>
			{children}
		</button>
	),
}));

vi.mock("@mdly/workspace-kit", () => ({
	DiffGroupsView: () => <div data-testid="diff-groups" />,
}));

describe("ExternalChangeReviewDialog", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function clickButton(label: string) {
		const button = [...container.querySelectorAll("button")].find(
			(el) => el.textContent === label,
		);
		act(() => button?.click());
	}

	it("renders nothing when closed", () => {
		act(() => {
			root.render(
				<ExternalChangeReviewDialog
					open={false}
					onOpenChange={vi.fn()}
					previousContent="old"
					currentContent="new"
					onUndo={vi.fn()}
				/>,
			);
		});

		expect(container.querySelector('[data-testid="modal"]')).toBeNull();
	});

	it("shows the diff and closes without undoing on Keep it", () => {
		const onOpenChange = vi.fn();
		const onUndo = vi.fn();

		act(() => {
			root.render(
				<ExternalChangeReviewDialog
					open={true}
					onOpenChange={onOpenChange}
					previousContent="old"
					currentContent="new"
					onUndo={onUndo}
				/>,
			);
		});

		expect(
			container.querySelector('[data-testid="diff-groups"]'),
		).not.toBeNull();

		clickButton("Keep it");

		expect(onUndo).not.toHaveBeenCalled();
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("calls onUndo and closes on Undo", () => {
		const onOpenChange = vi.fn();
		const onUndo = vi.fn();

		act(() => {
			root.render(
				<ExternalChangeReviewDialog
					open={true}
					onOpenChange={onOpenChange}
					previousContent="old"
					currentContent="new"
					onUndo={onUndo}
				/>,
			);
		});

		clickButton("Undo");

		expect(onUndo).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
