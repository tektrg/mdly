/**
 * Resolves the app's theme tokens the way a browser would, so tests can assert
 * on *colours* instead of on class names.
 *
 * This exists because the previous theming guard was a regex over component
 * source. It could only ever re-check the assumption the author already held,
 * which is why it stayed green through a real bug: `--sidebar-accent` is defined
 * as `var(--accent)` in all three dark themes, so the open document was painted
 * the hover colour and was invisible. A source grep cannot see that; resolving
 * the token can.
 *
 * Test-only. Nothing in the running app imports it.
 */

/** The six shipped permutations: light/dark x `data-contrast` default/soft/crisp. */
export const THEME_PERMUTATIONS = [
	":root",
	':root[data-contrast="soft"]',
	':root[data-contrast="crisp"]',
	".dark",
	'.dark[data-contrast="soft"]',
	'.dark[data-contrast="crisp"]',
] as const;

export type ThemePermutation = (typeof THEME_PERMUTATIONS)[number];

type Rgb = [number, number, number];

/**
 * Which blocks apply, in cascade order, for one permutation. A dark contrast
 * variant inherits `:root` then `.dark` then its own block — matching the real
 * cascade, where `.dark[data-contrast="crisp"]` only re-declares what it changes.
 */
function cascadeFor(permutation: ThemePermutation): string[] {
	if (permutation === ":root") return [":root"];
	if (permutation.startsWith(".dark")) {
		return permutation === ".dark"
			? [":root", ".dark"]
			: [":root", ".dark", permutation];
	}
	return [":root", permutation];
}

/** Declaration bodies keyed by selector, brace-matched so nested rules are kept. */
export function parseThemeBlocks(css: string): Map<string, string> {
	const blocks = new Map<string, string>();
	const header =
		/^(:root(?:\[data-contrast="\w+"\])?|\.dark(?:\[data-contrast="\w+"\])?)\s*\{/gm;
	let match = header.exec(css);
	while (match !== null) {
		let depth = 1;
		let index = match.index + match[0].length;
		const start = index;
		while (index < css.length && depth > 0) {
			if (css[index] === "{") depth += 1;
			else if (css[index] === "}") depth -= 1;
			index += 1;
		}
		const selector = match[1];
		blocks.set(
			selector,
			(blocks.get(selector) ?? "") + css.slice(start, index),
		);
		match = header.exec(css);
	}
	return blocks;
}

/**
 * The raw value of one custom property in one permutation — last declaration in
 * the cascade wins, exactly as CSS does. `var(...)` references are followed.
 */
export function resolveToken(
	blocks: Map<string, string>,
	permutation: ThemePermutation,
	token: string,
	seen: Set<string> = new Set(),
): string | null {
	let value: string | null = null;
	for (const selector of cascadeFor(permutation)) {
		const body = blocks.get(selector);
		if (!body) continue;
		const declarations = [
			...body.matchAll(new RegExp(`--${token}:\\s*([^;]+);`, "g")),
		];
		// Index rather than `.at(-1)`: the desktop tsconfig's lib predates it.
		const last = declarations[declarations.length - 1];
		if (last) value = last[1].trim();
	}
	if (value === null) return null;

	const reference = /^var\(--([\w-]+)\)$/.exec(value);
	if (reference) {
		if (seen.has(token)) return null;
		return resolveToken(
			blocks,
			permutation,
			reference[1],
			new Set(seen).add(token),
		);
	}
	return value;
}

/** oklch() -> sRGB, via Oklab and the standard sRGB transfer function. */
export function oklchToRgb(value: string): Rgb | null {
	const parsed = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(value);
	if (!parsed) return null;
	const [lightness, chroma, hue] = [
		Number(parsed[1]),
		Number(parsed[2]),
		Number(parsed[3]),
	];

	const radians = (hue * Math.PI) / 180;
	const a = chroma * Math.cos(radians);
	const b = chroma * Math.sin(radians);
	const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

	const linear: Rgb = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
	return linear.map((channel) => {
		const clamped = Math.min(1, Math.max(0, channel));
		return clamped <= 0.0031308
			? 12.92 * clamped
			: 1.055 * clamped ** (1 / 2.4) - 0.055;
	}) as Rgb;
}

/** The colour a token resolves to in one permutation, as sRGB. */
export function tokenRgb(
	blocks: Map<string, string>,
	permutation: ThemePermutation,
	token: string,
): Rgb | null {
	const value = resolveToken(blocks, permutation, token);
	return value === null ? null : oklchToRgb(value);
}

function relativeLuminance([r, g, b]: Rgb): number {
	const channel = (value: number) =>
		value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(foreground: Rgb, background: Rgb): number {
	const a = relativeLuminance(foreground);
	const b = relativeLuminance(background);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** How far apart two surface colours are, for "these must not look alike". */
export function surfaceDistance(a: Rgb, b: Rgb): number {
	return Math.abs(relativeLuminance(a) - relativeLuminance(b));
}
