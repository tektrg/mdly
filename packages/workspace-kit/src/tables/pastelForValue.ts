/**
 * Deterministic pastel chip colors for inferred-select values.
 *
 * The same string always maps to the same pastel so a "Todo" chip looks
 * identical in every cell and in the options menu — "random" on first sight,
 * stable across renders with no stored state.
 */
export type Pastel = {
	background: string;
	border: string;
	text: string;
};

export function pastelForValue(value: string): Pastel {
	const trimmed = value.trim();
	if (trimmed === "") {
		return {
			background: "hsl(220 12% 92%)",
			border: "hsl(220 10% 82%)",
			text: "hsl(220 12% 32%)",
		};
	}
	let hash = 0;
	for (let index = 0; index < trimmed.length; index += 1) {
		hash = (hash * 31 + trimmed.charCodeAt(index)) >>> 0;
	}
	const hue = hash % 360;
	return {
		background: `hsl(${hue} 72% 88%)`,
		border: `hsl(${hue} 55% 76%)`,
		text: `hsl(${hue} 38% 26%)`,
	};
}
