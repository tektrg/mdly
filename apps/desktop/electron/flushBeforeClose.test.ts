import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlushBeforeClose } from "./flushBeforeClose";

const event = () => ({ preventDefault: vi.fn() });

afterEach(() => {
	vi.useRealTimers();
});

describe("flush before close (saved views R20)", () => {
	it("holds the close until the renderer has flushed, then closes once", async () => {
		let finish: () => void = () => {};
		const requestFlush = vi.fn(
			() => new Promise<void>((resolve) => (finish = resolve)),
		);
		const close = vi.fn();
		const onClose = createFlushBeforeClose({
			requestFlush,
			close,
			timeoutMs: 2000,
		});

		const first = event();
		onClose(first);
		expect(first.preventDefault).toHaveBeenCalled();
		expect(requestFlush).toHaveBeenCalledTimes(1);
		expect(close).not.toHaveBeenCalled();

		// A second close while flushing is held too, without a second flush.
		const second = event();
		onClose(second);
		expect(second.preventDefault).toHaveBeenCalled();
		expect(requestFlush).toHaveBeenCalledTimes(1);

		finish();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(close).toHaveBeenCalledTimes(1);

		// The real close passes straight through.
		const final = event();
		onClose(final);
		expect(final.preventDefault).not.toHaveBeenCalled();
	});

	it("closes anyway after the timeout when the renderer never answers", async () => {
		vi.useFakeTimers();
		const close = vi.fn();
		const onClose = createFlushBeforeClose({
			requestFlush: () => new Promise<void>(() => {}),
			close,
			timeoutMs: 2000,
		});
		onClose(event());
		await vi.advanceTimersByTimeAsync(1999);
		expect(close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("a failing flush still closes", async () => {
		const close = vi.fn();
		const onClose = createFlushBeforeClose({
			requestFlush: () => Promise.reject(new Error("boom")),
			close,
			timeoutMs: 2000,
		});
		onClose(event());
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(close).toHaveBeenCalledTimes(1);
	});
});
