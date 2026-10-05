import { useEffect, useState } from "react";

/** Local `YYYY-MM-DD` of `at`. */
export function localDayKey(at: Date = new Date()): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Milliseconds from `at` until the next local midnight (plus a small margin). */
export function msUntilNextLocalDay(at: Date = new Date()): number {
	const next = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
	return next.getTime() - at.getTime() + 50;
}

/**
 * Today's local day, re-read at midnight and whenever the window regains focus
 * (a sleeping Mac skips timers). Date-range groups ("Today", "Yesterday")
 * depend on it, so they roll over without a reload.
 */
export function useLocalDayKey(): string {
	const [dayKey, setDayKey] = useState(() => localDayKey());
	// biome-ignore lint/correctness/useExhaustiveDependencies: dayKey re-arms the timer for the next midnight.
	useEffect(() => {
		const refresh = () => setDayKey(localDayKey());
		const timer = setTimeout(refresh, msUntilNextLocalDay());
		window.addEventListener("focus", refresh);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("focus", refresh);
		};
	}, [dayKey]);
	return dayKey;
}
