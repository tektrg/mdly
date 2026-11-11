// Keeps the app window pinned to the mdly renderer: remote iframe embeds (and
// anything else) may never navigate it, open Electron windows, or claim
// device permissions. Links and popups go to the system browser instead.

export const EMBED_LOAD_FAILED_CHANNEL = "desktop:embed-load-failed";

/** Same-origin as the renderer's own URL (dev server or `app://mdly`). */
export function isAppUrl(url: string, appUrl: string): boolean {
	try {
		// `URL.origin` is "null" for custom schemes like app://, so compare the
		// scheme + host explicitly.
		const a = new URL(url);
		const b = new URL(appUrl);
		return a.protocol === b.protocol && a.host === b.host;
	} catch {
		return false;
	}
}

/** Only plain web links are handed to the OS browser. */
export function isExternalWebUrl(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

/**
 * Permissions a remote embed may get: fullscreen (YouTube's button) and
 * clipboard writes (embed "copy link" buttons). Camera, mic, geolocation,
 * notifications, MIDI, HID, etc. are denied for any non-app origin.
 */
const EMBED_PERMISSIONS = new Set(["fullscreen", "clipboard-sanitized-write"]);

export function isPermissionAllowed(
	permission: string,
	requestingUrl: string,
	appUrl: string,
): boolean {
	if (isAppUrl(requestingUrl, appUrl)) return true;
	return EMBED_PERMISSIONS.has(permission);
}

type GuardedContents = {
	getURL(): string;
	on(
		event: "will-navigate",
		listener: (event: { preventDefault(): void; url: string }) => void,
	): unknown;
	on(
		event: "did-fail-load",
		listener: (
			event: unknown,
			errorCode: number,
			errorDescription: string,
			validatedUrl: string,
			isMainFrame: boolean,
		) => void,
	): unknown;
	setWindowOpenHandler(
		handler: (details: { url: string }) => { action: "deny" },
	): void;
	send(channel: string, ...args: unknown[]): void;
	session: {
		setPermissionRequestHandler(
			handler: (
				contents: unknown,
				permission: string,
				callback: (granted: boolean) => void,
				details: { requestingUrl?: string },
			) => void,
		): void;
		setPermissionCheckHandler(
			handler: (
				contents: unknown,
				permission: string,
				requestingOrigin: string,
			) => boolean,
		): void;
	};
};

/**
 * Wires the guards onto one window's webContents.
 *
 * - `will-navigate` fires only for the MAIN frame: anything off the app origin
 *   is cancelled (and opened externally when it is a web link). Embed frames
 *   navigating inside themselves fire `will-frame-navigate` instead, which we
 *   leave alone — the sandbox (no `allow-top-navigation`) already stops a
 *   frame from targeting the top window.
 * - `setWindowOpenHandler`: every `window.open` / `target=_blank` (allowed by
 *   the embed sandbox's `allow-popups`) is denied as an Electron window —
 *   which would otherwise inherit the preload — and opened in the browser.
 * - Sub-frame load failures are forwarded so the embed can show its fallback
 *   card (X-Frame-Options / frame-ancestors refusals fire no DOM error).
 */
export function installNavigationGuards(
	contents: GuardedContents,
	openExternal: (url: string) => unknown,
) {
	const appUrl = () => contents.getURL();
	contents.on("will-navigate", (event) => {
		if (isAppUrl(event.url, appUrl())) return;
		event.preventDefault();
		if (isExternalWebUrl(event.url)) void openExternal(event.url);
	});
	contents.setWindowOpenHandler(({ url }) => {
		if (isExternalWebUrl(url)) void openExternal(url);
		return { action: "deny" };
	});
	contents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
			// -3 = ERR_ABORTED (navigation replaced / iframe removed): not a failure.
			if (isMainFrame || errorCode === -3) return;
			contents.send(EMBED_LOAD_FAILED_CHANNEL, {
				url: validatedUrl,
				errorCode,
				errorDescription,
			});
		},
	);
	contents.session.setPermissionRequestHandler(
		(_contents, permission, callback, details) => {
			callback(
				isPermissionAllowed(permission, details.requestingUrl ?? "", appUrl()),
			);
		},
	);
	contents.session.setPermissionCheckHandler(
		(_contents, permission, requestingOrigin) =>
			isPermissionAllowed(permission, requestingOrigin, appUrl()),
	);
}
