// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MainProcessErrorNoticePayload } from "../desktopApi/types";
import { MainProcessErrorNotice } from "./MainProcessErrorNotice";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { onMainProcessError, toastError } = vi.hoisted(() => ({
	onMainProcessError: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("../desktopApi", () => ({
	desktopApi: { onMainProcessError },
}));

vi.mock("sonner", () => ({
	toast: { error: toastError },
	Toaster: () => null,
}));

let container: HTMLElement;
let root: Root | null = null;

function subscribedCallback(): (
	payload: MainProcessErrorNoticePayload,
) => void {
	expect(onMainProcessError).toHaveBeenCalledTimes(1);
	const call = onMainProcessError.mock.calls[0];
	expect(call).toBeDefined();
	return call?.[0] as (payload: MainProcessErrorNoticePayload) => void;
}

type ToastOptions = {
	id?: string;
	description?: string;
	duration?: number;
	closeButton?: boolean;
};

function lastToastCall(): readonly [string, ToastOptions] {
	const allCalls = toastError.mock.calls;
	const call = allCalls[allCalls.length - 1];
	expect(call).toBeDefined();
	return (call ?? ["", {}]) as unknown as readonly [string, ToastOptions];
}

beforeEach(() => {
	vi.clearAllMocks();
	onMainProcessError.mockReturnValue(() => {});
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	act(() => {
		root?.unmount();
	});
	root = null;
	container.remove();
});

function mount(): void {
	act(() => {
		root = createRoot(container);
		root.render(<MainProcessErrorNotice />);
	});
}

describe("MainProcessErrorNotice", () => {
	it("raises one dismissible, non-auto-dismissing toast per fault", () => {
		mount();
		const payload = {
			key: "Error: WebSocket was closed",
			message: "Error: WebSocket was closed",
		};

		act(() => {
			subscribedCallback()(payload);
		});

		expect(toastError).toHaveBeenCalledTimes(1);
		const [title, options] = lastToastCall();
		expect(title).toBe("A background problem occurred");
		expect(options.description).toContain("Error: WebSocket was closed");
		expect(options.description).not.toMatch(/at \S+ \(.+:\d+:\d+\)/);
		// Stays until dismissed; closable without touching the global default.
		expect(options.duration).toBe(Number.POSITIVE_INFINITY);
		expect(options.closeButton).toBe(true);
	});

	it("a repeat of the same fault updates instead of stacking (stable toast id)", () => {
		mount();
		const payload = {
			key: "Error: WebSocket was closed",
			message: "Error: WebSocket was closed",
		};

		act(() => {
			subscribedCallback()(payload);
			subscribedCallback()(payload);
		});

		expect(toastError).toHaveBeenCalledTimes(2);
		const [, firstOptions] = toastError.mock.calls[0] as unknown as readonly [
			string,
			ToastOptions,
		];
		const [, secondOptions] = lastToastCall();
		expect(firstOptions.id).toBe(secondOptions.id);
		// sonner routes same-id toasts to the single visible notice.
		expect(secondOptions.id).toContain("Error: WebSocket was closed");
	});

	it("unsubscribes on unmount", () => {
		const dispose = vi.fn();
		onMainProcessError.mockReturnValue(dispose);
		mount();
		act(() => {
			root?.unmount();
		});
		root = null;
		expect(dispose).toHaveBeenCalledTimes(1);
	});
});
