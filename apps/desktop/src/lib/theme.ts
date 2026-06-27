export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export const CONTRAST_PREFERENCES = ["soft", "standard", "crisp"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ContrastPreference = (typeof CONTRAST_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

const DARK_MODE_QUERY = "(prefers-color-scheme: dark)";

export function isThemePreference(value: unknown): value is ThemePreference {
	return value === "system" || value === "light" || value === "dark";
}

export function isContrastPreference(
	value: unknown,
): value is ContrastPreference {
	return value === "soft" || value === "standard" || value === "crisp";
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

export function applyStoredAppearancePreferences(storageKey: string) {
	if (typeof document === "undefined") return;
	applyThemePreference(readStoredThemePreference(storageKey));
	applyContrastPreference(readStoredContrastPreference(storageKey));
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
			};
		};
		return parsed.ui ?? null;
	} catch {
		return null;
	}
}
