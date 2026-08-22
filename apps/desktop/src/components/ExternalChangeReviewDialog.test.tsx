// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalChangeReviewDialog } from "./ExternalChangeReviewDialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Stand-ins for the kit's real Modal/DiffReviewPanel: only what this test
// needs to drive `onConfirm`/`onCancel` and observe whether the dialog is
// still mounted, matching the pattern already used in
// NotionDatabaseViewer.test.tsx for mocking @hubble.md/ui.
vi.mock("@hubble.md/ui", () => ({
	Modal: ({ open, children }: { open: boolean; children: ReactNode }) =>
		open ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock("@mdly/workspace-kit", () => ({
	DiffReviewPanel: ({
		onConfirm,
		onCancel,
	}: {
		onConfirm: (mergedText: string) => void;
		onCancel?: () => void;
	}) => (
		<div>
			<button
				type="button"
				data-testid="apply"
				onClick={() => onConfirm("merged-text")}
			>
				Apply
			</button>
			{onCancel && (
				<button type="button" data-testid="cancel" onClick={onCancel}>
					Cancel
				</button>
			)}
		</div>
	),
}));

/**
 * Blocker 4: the dialog used to close synchronously right after calling
 * `onConfirm`, without waiting for `resolveExternalChangeReview`'s result. On
 * a failed write, the dialog vanished even though the store correctly kept
 * the pending review/picks around -- the user had nothing left to retry
 * from. These tests prove the dialog now awaits the result and only closes
 * on success.
 */
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

	async function clickApply() {
		const applyButton = container.querySelector<HTMLButtonElement>(
			'[data-testid="apply"]',
		);
		await act(async () => {
			applyButton?.click();
			// Flush the microtask queue so the dialog's own `await onConfirm(...)`
			// settles before assertions run.
			await Promise.resolve();
			await Promise.resolve();
		});
	}

	it("stays open with the modal still mounted when the confirm write fails", async () => {
		const onOpenChange = vi.fn();
		const onConfirm = vi.fn(async () => false);

		await act(async () => {
			root.render(
				<ExternalChangeReviewDialog
					open={true}
					onOpenChange={onOpenChange}
					oldText="old"
					newText="new"
					onConfirm={onConfirm}
				/>,
			);
		});

		await clickApply();

		expect(onConfirm).toHaveBeenCalledWith("merged-text");
		// The dialog must not have been told to close -- the user's picks
		// (held inside the real DiffReviewPanel) are never torn down.
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(container.querySelector('[data-testid="modal"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="apply"]')).not.toBeNull();
	});

	it("closes only after the confirm write actually succeeds", async () => {
		const onOpenChange = vi.fn();
		const onConfirm = vi.fn(async () => true);

		await act(async () => {
			root.render(
				<ExternalChangeReviewDialog
					open={true}
					onOpenChange={onOpenChange}
					oldText="old"
					newText="new"
					onConfirm={onConfirm}
				/>,
			);
		});

		await clickApply();

		expect(onConfirm).toHaveBeenCalledWith("merged-text");
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
