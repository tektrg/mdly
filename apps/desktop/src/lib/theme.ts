export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export const CONTRAST_PREFERENCES = ["soft", "standard", "crisp"] as const;
export const SYSTEM_EDITOR_FONT_PREFERENCE = "system";

/**
 * Heading font choices. To add one: add an entry here, a matching
 * `[data-heading-font="<id>"]` block in workspace-kit's EditorView.css, and
 * (if it ships a file) its @font-face in src/index.css.
 */
export const HEADING_FONT_OPTIONS = [
	{ id: "default", label: "Default" },
	{ id: "instrument-serif", label: "Instrument Serif" },
	{ id: "fraunces", label: "Fraunces" },
	{ id: "system-serif", label: "System serif" },
] as const;
export const DEFAULT_HEADING_FONT_PREFERENCE = "default";

export type HeadingFontPreference = (typeof HEADING_FONT_OPTIONS)[number]["id"];
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ContrastPreference = (typeof CONTRAST_PREFERENCES)[number];
export type EditorFontPreference = string;
export type ResolvedTheme = "light" | "dark";

const DARK_MODE_QUERY = "(prefers-color-scheme: dark)";
const MAX_EDITOR_FONT_FAMILY_LENGTH = 120;
const SYSTEM_EDITOR_FONT_FAMILY =
	'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const LEGACY_EDITOR_FONT_PREFERENCE_MIGRATIONS: Record<string, string> = {
	mono: "Menlo",
	rounded: "Fredoka",
	serif: "Georgia",
};

export function isThemePreference(value: unknown): value is ThemePreference {
	return value === "system" || value === "light" || value === "dark";
}

export function isContrastPreference(
	value: unknown,
): value is ContrastPreference {
	return value === "soft" || value === "standard" || value === "crisp";
}

export function isHeadingFontPreference(
	value: unknown,
): value is HeadingFontPreference {
	return HEADING_FONT_OPTIONS.some((option) => option.id === value);
}

export function isEditorFontPreference(
	value: unknown,
): value is EditorFontPreference {
	return normalizeEditorFontPreference(value) !== null;
}

export function normalizeEditorFontPreference(
	value: unknown,
): EditorFontPreference | null {
	if (typeof value !== "string") return null;
	const fontFamily = value.trim();
	const legacyFontFamily = LEGACY_EDITOR_FONT_PREFERENCE_MIGRATIONS[fontFamily];
	if (legacyFontFamily) return legacyFontFamily;
	if (fontFamily.length === 0) return null;
	if (fontFamily.length > MAX_EDITOR_FONT_FAMILY_LENGTH) return null;
	if (hasControlCharacter(fontFamily)) return null;
	return fontFamily;
}

function hasControlCharacter(value: string) {
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint <= 31 || codePoint === 127) return true;
	}
	return false;
}

export function resolveThemePreference({
	preference,
	systemPrefersDark,
}: {
	preference: ThemePreference;
	systemPrefersDark: boolean;
}): ResolvedTheme {
	if (preference === "system") {
		return systemPrefersDark ? "dark" : "light";
	}
	return preference;
}

export function applyResolvedTheme(
	resolvedTheme: ResolvedTheme,
	root: HTMLElement = document.documentElement,
) {
	root.classList.toggle("dark", resolvedTheme === "dark");
	root.style.colorScheme = resolvedTheme;
}

export function readStoredThemePreference(
	storageKey: string,
	storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): ThemePreference {
	const ui = readStoredUi(storageKey, storage);
	return isThemePreference(ui?.themePreference) ? ui.themePreference : "system";
}

export function readStoredContrastPreference(
	storageKey: string,
	storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): ContrastPreference {
	const ui = readStoredUi(storageKey, storage);
	return isContrastPreference(ui?.contrastPreference)
		? ui.contrastPreference
		: "standard";
}

export function readStoredEditorFontPreference(
	storageKey: string,
	storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): EditorFontPreference {
	const ui = readStoredUi(storageKey, storage);
	return (
		normalizeEditorFontPreference(ui?.editorFontPreference) ??
		SYSTEM_EDITOR_FONT_PREFERENCE
	);
}

export function readStoredHeadingFontPreference(
	storageKey: string,
	storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): HeadingFontPreference {
	const ui = readStoredUi(storageKey, storage);
	return isHeadingFontPreference(ui?.headingFontPreference)
		? ui.headingFontPreference
		: DEFAULT_HEADING_FONT_PREFERENCE;
}

export function applyStoredAppearancePreferences(storageKey: string) {
	if (typeof document === "undefined") return;
	applyThemePreference(readStoredThemePreference(storageKey));
	applyContrastPreference(readStoredContrastPreference(storageKey));
	applyEditorFontPreference(readStoredEditorFontPreference(storageKey));
	applyHeadingFontPreference(readStoredHeadingFontPreference(storageKey));
}

export function applyThemePreference(preference: ThemePreference) {
	applyResolvedTheme(
		resolveThemePreference({
			preference,
			systemPrefersDark: getSystemPrefersDark(),
		}),
	);
}

export function applyContrastPreference(
	preference: ContrastPreference,
	root: HTMLElement = document.documentElement,
) {
	root.dataset.contrast = preference;
}

export function applyEditorFontPreference(
	preference: EditorFontPreference,
	root: HTMLElement = document.documentElement,
) {
	const fontFamily = normalizeEditorFontPreference(preference);
	if (!fontFamily || fontFamily === SYSTEM_EDITOR_FONT_PREFERENCE) {
		root.dataset.editorFont = SYSTEM_EDITOR_FONT_PREFERENCE;
		root.style.removeProperty("--editor-font-family");
		return;
	}

	root.dataset.editorFont = "custom";
	root.style.setProperty(
		"--editor-font-family",
		`${quoteCssFontFamily(fontFamily)}, ${SYSTEM_EDITOR_FONT_FAMILY}`,
	);
}

/** The editor stylesheet keys heading typography off `data-heading-font`. */
export function applyHeadingFontPreference(
	preference: HeadingFontPreference,
	root: HTMLElement = document.documentElement,
) {
	root.dataset.headingFont = isHeadingFontPreference(preference)
		? preference
		: DEFAULT_HEADING_FONT_PREFERENCE;
}

function quoteCssFontFamily(fontFamily: string) {
	return `"${fontFamily.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function syncThemePreference(preference: ThemePreference) {
	const mediaQuery = getDarkModeMediaQuery();

	const sync = () => {
		applyResolvedTheme(
			resolveThemePreference({
				preference,
				systemPrefersDark: mediaQuery?.matches ?? false,
			}),
		);
	};

	sync();

	if (preference !== "system" || !mediaQuery) {
		return () => {};
	}

	mediaQuery.addEventListener("change", sync);
	return () => mediaQuery.removeEventListener("change", sync);
}

function getSystemPrefersDark() {
	return getDarkModeMediaQuery()?.matches ?? false;
}

function getDarkModeMediaQuery() {
	if (
		typeof window === "undefined" ||
		typeof window.matchMedia !== "function"
	) {
		return null;
	}
	return window.matchMedia(DARK_MODE_QUERY);
}

function safeLocalStorage() {
	if (typeof localStorage === "undefined") return null;
	return localStorage;
}

function readStoredUi(
	storageKey: string,
	storage: Pick<Storage, "getItem"> | null,
) {
	if (!storage) return null;
	const raw = storage.getItem(storageKey);
	if (!raw) return null;

	try {
		const parsed = JSON.parse(raw) as {
			ui?: {
				themePreference?: unknown;
				contrastPreference?: unknown;
				editorFontPreference?: unknown;
				headingFontPreference?: unknown;
			};
		};
		return parsed.ui ?? null;
	} catch {
		return null;
	}
}
