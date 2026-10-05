// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	localDayKey,
	msUntilNextLocalDay,
	useLocalDayKey,
} from "./useLocalDayKey";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.useRealTimers());

describe("useLocalDayKey", () => {
	it("rolls over at local midnight and on window focus", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 9, 5, 23, 59, 0));
		expect(msUntilNextLocalDay()).toBe(60_050);
		const seen: string[] = [];
		function Probe() {
			seen.push(useLocalDayKey());
			return null;
		}
		const root = createRoot(document.createElement("div"));
		act(() => root.render(<Probe />));
		expect(seen.at(-1)).toBe("2026-10-05");
		act(() => vi.advanceTimersByTime(61_000));
		expect(seen.at(-1)).toBe("2026-10-06");
		// A sleeping Mac skips timers: focus re-reads the day.
		vi.setSystemTime(new Date(2026, 9, 8, 9, 0, 0));
		act(() => window.dispatchEvent(new Event("focus")));
		expect(seen.at(-1)).toBe(localDayKey());
		act(() => root.unmount());
	});
});
