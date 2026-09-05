/**
 * Web comment author label (Round 7): the locked decision is device label,
 * no name prompt, no accounts — e.g. "Safari - iPhone", "Chrome - Mac".
 * Pure function of a UA string so it tests without a real navigator.
 * Order matters: Chromium forks (Edge, Opera) and iOS forks (CriOS, FxiOS,
 * EdgiOS) all carry a "Safari"/"Chrome" token too, so they match first.
 */
export function deviceLabelFor(userAgent: string): string {
	const ua = userAgent;
	const browser =
		/Edg\//.test(ua) || /EdgiOS\//.test(ua)
			? "Edge"
			: /OPR\/|Opera/.test(ua)
				? "Opera"
				: /FxiOS\//.test(ua) || /Firefox\//.test(ua)
					? "Firefox"
					: /CriOS\//.test(ua)
						? "Chrome"
						: /Chrome\//.test(ua)
							? "Chrome"
							: /Safari\//.test(ua)
								? "Safari"
								: null;
	const device = /iPhone/.test(ua)
		? "iPhone"
		: /iPad/.test(ua)
			? "iPad"
			: /Android/.test(ua)
				? "Android"
				: /Macintosh|Mac OS X/.test(ua)
					? "Mac"
					: /Windows/.test(ua)
						? "Windows"
						: /Linux/.test(ua)
							? "Linux"
							: null;
	if (browser && device) return `${browser} - ${device}`;
	return "Browser";
}
