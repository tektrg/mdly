import { useEffect, useState } from "react";

/** Tailwind `md` breakpoint floor (768px): below this is the phone layout. */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(
		() =>
			typeof window !== "undefined" &&
			typeof window.matchMedia !== "undefined" &&
			window.matchMedia(query).matches,
	);
	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;
		const mql = window.matchMedia(query);
		setMatches(mql.matches);
		const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}
