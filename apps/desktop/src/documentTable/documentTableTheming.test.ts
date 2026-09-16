import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	contrastRatio,
	parseThemeBlocks,
	surfaceDistance,
	THEME_PERMUTATIONS,
	tokenRgb,
} from "./themeContrast";

const COMPONENT_FILES = [
	"./DocumentRowList.tsx",
	"./DocumentTable.tsx",
	"./DocumentNarrowList.tsx",
	"./DocumentFilterInput.tsx",
	"./windowChromeInset.ts",
	"../components/MainPanel.tsx",
];

function readComponent(relativePath: string) {
	return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), {
		encoding: "utf8",
	});
}

describe("document table theming", () => {
	// Six theme permutations ship (light/dark x data-contrast soft/crisp/default).
	// A raw colour is correct in at most one of them.
	it.each(COMPONENT_FILES)("%s hardcodes no colour", (file) => {
		const source = readComponent(file);
		expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
		expect(source).not.toMatch(
			/\b(rgb|rgba|hsl|hsla|hwb|oklch|oklab|lab|lch|color)\(/,
		);
		// Tailwind's own palette is as theme-blind as a hex literal.
		expect(source).not.toMatch(
			/\b(?:bg|text|border|ring|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/,
		);
	});

	it("uses the app's hover token, not NotionDatabaseViewer's outlier", () => {
		const source = readComponent("./DocumentRowList.tsx");
		expect(source).toContain("hover:bg-accent");
		expect(source).not.toContain("bg-muted/40");
	});

	// `theme.css:17` — `--accent` is hover, `--selected` is selection. The two must
	// never resolve to the same colour, or the open document becomes invisible.
	// `--sidebar-accent` is the trap: it only escalates to the real selection colour
	// inside `[data-sidebar-root]:focus-within`, and every dark permutation defines
	// it as plain `var(--accent)` — so on this list it WAS the hover colour.
	it("marks the active row with the selection token, never the sidebar alias", () => {
		const source = readComponent("./DocumentRowList.tsx");
		expect(source).toContain("bg-selected");
		expect(source).not.toContain("bg-sidebar-accent");
	});

	it("adds no virtualization dependency", () => {
		const manifest = readComponent("../../package.json");
		expect(manifest).not.toContain("react-window");
		expect(manifest).not.toContain("react-virtualized");
		expect(manifest).not.toContain("@tanstack/react-virtual");
	});

	it("disables every transition it declares under reduced motion", () => {
		for (const file of COMPONENT_FILES) {
			const source = readComponent(file);
			const transitions = source.match(
				/transition-\[[^\]]+\]|transition-colors/g,
			);
			if (!transitions) continue;
			expect(
				source,
				`${file} declares motion without a reduced-motion opt-out`,
			).toContain("motion-reduce:transition-none");
			// `transition: all` is never acceptable — it animates properties the
			// compositor cannot handle and fights every future style change.
			expect(source).not.toContain("transition-all");
		}
	});
});

/**
 * The guards above read component source; these read the stylesheet and resolve
 * the tokens the way a browser would. That distinction is the whole point — a
 * source grep stayed green through the bug where the open document was painted
 * the hover colour, because the class name was fine and the *token* was not.
 */
describe("theme tokens, resolved", () => {
	const blocks = parseThemeBlocks(
		readComponent("../../../../packages/ui/src/theme.css"),
	);

	function rgb(
		permutation: (typeof THEME_PERMUTATIONS)[number],
		token: string,
	) {
		const value = tokenRgb(blocks, permutation, token);
		if (!value) throw new Error(`--${token} unresolved in ${permutation}`);
		return value;
	}

	it("parses all six shipped permutations", () => {
		for (const permutation of THEME_PERMUTATIONS) {
			expect(rgb(permutation, "background")).toHaveLength(3);
		}
	});

	// `theme.css:17` — `--accent` is hover, `--selected` is selection. If a theme
	// ever defines one as the other, the open document becomes invisible under the
	// cursor. That is exactly what `--sidebar-accent` does in all three dark
	// themes, which is why this list must never use it.
	it.each(THEME_PERMUTATIONS)("%s keeps hover and selection distinct", (p) => {
		expect(
			surfaceDistance(rgb(p, "accent"), rgb(p, "selected")),
		).toBeGreaterThan(0.01);
	});

	// Folder and Modified are content, not chrome. The floor is the design
	// system's own muted level; the active row clears full WCAG AA because it can.
	it.each(THEME_PERMUTATIONS)("%s keeps idle secondary text legible", (p) => {
		const ratio = contrastRatio(
			rgb(p, "muted-foreground"),
			rgb(p, "background"),
		);
		expect(ratio).toBeGreaterThanOrEqual(3.5);
	});

	it.each(
		THEME_PERMUTATIONS,
	)("%s keeps secondary text on the open row at AA", (p) => {
		const ratio = contrastRatio(
			rgb(p, "selected-foreground"),
			rgb(p, "selected"),
		);
		expect(ratio).toBeGreaterThanOrEqual(4.5);
	});

	// The regression this replaces: `text-muted-foreground/70` over `--selected`
	// measured 1.98:1 in light/soft. Pinning the old approach's number keeps the
	// reason for the change legible to whoever is tempted to revert it.
	it("rejects muted text on the selected surface, which is what failed", () => {
		const worst = Math.min(
			...THEME_PERMUTATIONS.map((p) =>
				contrastRatio(rgb(p, "muted-foreground"), rgb(p, "selected")),
			),
		);
		expect(worst).toBeLessThan(4.5);
	});
});
