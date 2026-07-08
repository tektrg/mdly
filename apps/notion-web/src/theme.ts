// Dark mode: follow the OS preference. Hubble's editor theme (theme.css) keys
// its dark palette off a `.dark` class on <html>, so we toggle that class in
// response to the browser's prefers-color-scheme, and keep it in sync when the
// OS setting changes while the app is open.

const DARK_QUERY = "(prefers-color-scheme: dark)";

function applyTheme(isDark: boolean): void {
	document.documentElement.classList.toggle("dark", isDark);
}

export function initTheme(): void {
	const media = window.matchMedia(DARK_QUERY);
	applyTheme(media.matches);
	media.addEventListener("change", (event) => applyTheme(event.matches));
}
