// @vitest-environment happy-dom

import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomSheet } from "../bottomSheet";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function renderSheet(
	props: Partial<React.ComponentProps<typeof BottomSheet>> = {},
) {
	const el = document.createElement("div");
	document.body.appendChild(el);
	const root = createRoot(el);
	const onOpenChange = vi.fn();
	act(() => {
		root.render(
			<BottomSheet
				open
				onOpenChange={onOpenChange}
				title="Contents"
				{...props}
			>
				<p data-sheet-body>body</p>
			</BottomSheet>,
		);
	});
	return {
		el,
		onOpenChange,
		unmount: () => {
			act(() => root.unmount());
			el.remove();
		},
	};
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("BottomSheet", () => {
	it("renders title and children when open", () => {
		const { unmount } = renderSheet();
		try {
			expect(document.body.textContent).toContain("Contents");
			expect(
				document.body.querySelector("[data-sheet-body]"),
			).not.toBeNull();
		} finally {
			unmount();
		}
	});

	it("starts at half snap and the handle toggles to full", () => {
		const { unmount } = renderSheet();
		try {
			const popup = document.body.querySelector(
				'[data-snap="half"]',
			) as HTMLElement | null;
			expect(popup).not.toBeNull();
			const handle = document.body.querySelector(
				'button[aria-label="Expand panel"]',
			) as HTMLButtonElement | null;
			expect(handle).not.toBeNull();
			act(() => {
				handle?.click();
			});
			expect(
				document.body.querySelector('[data-snap="full"]'),
			).not.toBeNull();
			expect(
				document.body.querySelector('button[aria-label="Collapse panel"]'),
			).not.toBeNull();
		} finally {
			unmount();
		}
	});

	it("Close button reports open=false", () => {
		const { onOpenChange, unmount } = renderSheet();
		try {
			const close = document.body.querySelector(
				'button[aria-label="Close"]',
			) as HTMLButtonElement | null;
			expect(close).not.toBeNull();
			act(() => {
				close?.click();
			});
			expect(onOpenChange).toHaveBeenCalled();
			expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
		} finally {
			unmount();
		}
	});

	it("renders nothing when closed", () => {
		const { unmount } = renderSheet({ open: false });
		try {
			expect(
				document.body.querySelector("[data-sheet-body]"),
			).toBeNull();
		} finally {
			unmount();
		}
	});
});
