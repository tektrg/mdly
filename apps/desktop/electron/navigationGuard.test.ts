import { describe, expect, it, vi } from "vitest";
import {
	EMBED_LOAD_FAILED_CHANNEL,
	installNavigationGuards,
	isAppUrl,
	isLocalFrameEscape,
	isPermissionAllowed,
	widenWildcardFrameAncestors,
} from "./navigationGuard";

const APP = "app://mdly/index.html";

function fakeContents(url = APP) {
	const listeners: Record<string, (...args: unknown[]) => void> = {};
	let openHandler: ((d: { url: string }) => { action: string }) | null = null;
	let permissionHandler:
		| ((
				c: unknown,
				p: string,
				cb: (g: boolean) => void,
				d: { requestingUrl?: string },
		  ) => void)
		| null = null;
	const contents = {
		getURL: () => url,
		on: (event: string, listener: (...args: unknown[]) => void) => {
			listeners[event] = listener;
		},
		setWindowOpenHandler: (h: typeof openHandler) => {
			openHandler = h;
		},
		send: vi.fn(),
		session: {
			setPermissionRequestHandler: (h: typeof permissionHandler) => {
				permissionHandler = h;
			},
			setPermissionCheckHandler: vi.fn(),
		},
	};
	const openExternal = vi.fn();
	// biome-ignore lint/suspicious/noExplicitAny: structural fake
	installNavigationGuards(contents as any, openExternal);
	return {
		contents,
		openExternal,
		navigate(target: string) {
			const event = { url: target, preventDefault: vi.fn() };
			listeners["will-navigate"]?.(event);
			return event;
		},
		open: (target: string) => openHandler?.({ url: target }),
		fail: (...args: unknown[]) => listeners["did-fail-load"]?.({}, ...args),
		permission(p: string, requestingUrl: string) {
			let granted: boolean | null = null;
			permissionHandler?.(
				{},
				p,
				(g) => {
					granted = g;
				},
				{ requestingUrl },
			);
			return granted;
		},
	};
}

describe("navigation guards", () => {
	it("blocks the main window from navigating to a remote embed site", () => {
		const g = fakeContents();
		const event = g.navigate("https://evil.example/phish");
		expect(event.preventDefault).toHaveBeenCalled();
		expect(g.openExternal).toHaveBeenCalledWith("https://evil.example/phish");
	});

	it("blocks non-web schemes without opening them", () => {
		const g = fakeContents();
		const event = g.navigate("file:///etc/hosts");
		expect(event.preventDefault).toHaveBeenCalled();
		expect(g.openExternal).not.toHaveBeenCalled();
	});

	it("allows in-app navigation (dev server reload / app://)", () => {
		const g = fakeContents("http://localhost:5173/");
		expect(
			g.navigate("http://localhost:5173/?x").preventDefault,
		).not.toHaveBeenCalled();
		const p = fakeContents();
		expect(
			p.navigate("app://mdly/index.html#a").preventDefault,
		).not.toHaveBeenCalled();
	});

	it("denies every popup window and sends web links to the browser", () => {
		const g = fakeContents();
		expect(g.open("https://twitter.com/x")).toEqual({ action: "deny" });
		expect(g.openExternal).toHaveBeenCalledWith("https://twitter.com/x");
		expect(g.open("javascript:alert(1)")).toEqual({ action: "deny" });
		expect(g.openExternal).toHaveBeenCalledTimes(1);
	});

	it("forwards sub-frame load failures, ignores main frame and aborts", () => {
		const g = fakeContents();
		g.fail(-27, "ERR_BLOCKED_BY_RESPONSE", "https://x.com/e", false);
		g.fail(-3, "ERR_ABORTED", "https://x.com/e", false);
		g.fail(-105, "ERR_NAME_NOT_RESOLVED", APP, true);
		expect(g.contents.send).toHaveBeenCalledTimes(1);
		expect(g.contents.send).toHaveBeenCalledWith(EMBED_LOAD_FAILED_CHANNEL, {
			url: "https://x.com/e",
			errorCode: -27,
			errorDescription: "ERR_BLOCKED_BY_RESPONSE",
		});
	});

	it("denies device permissions to remote embeds, keeps fullscreen", () => {
		const g = fakeContents();
		expect(g.permission("media", "https://www.youtube.com/embed/x")).toBe(
			false,
		);
		expect(g.permission("geolocation", "https://x.com")).toBe(false);
		expect(g.permission("fullscreen", "https://www.youtube.com/embed/x")).toBe(
			true,
		);
		expect(g.permission("media", APP)).toBe(true);
	});

	it("app origin match works for custom schemes", () => {
		expect(isAppUrl("app://mdly/a", APP)).toBe(true);
		expect(isAppUrl("hubble-asset://local/a", APP)).toBe(false);
		expect(
			isPermissionAllowed("notifications", "hubble-asset://local/a", APP),
		).toBe(false);
	});
});

describe("local html embed cannot leave hubble-asset (window.name token leak)", () => {
	it("blocks a hubble-asset frame navigating to a remote page", () => {
		expect(
			isLocalFrameEscape(
				"hubble-asset://x/%2Fw/a.html",
				"https://evil.example/",
			),
		).toBe(true);
		expect(
			isLocalFrameEscape(
				"hubble-asset://x/%2Fw/a.html",
				"hubble-asset://x/%2Fw/b.html",
			),
		).toBe(false);
		expect(
			isLocalFrameEscape(
				"https://youtube.com/embed/1",
				"https://evil.example/",
			),
		).toBe(false);
		expect(isLocalFrameEscape("", "https://a.example/")).toBe(false);
	});

	it("wires will-frame-navigate: cancels and opens web links externally", () => {
		const listeners: Record<string, (...a: unknown[]) => void> = {};
		const contents = {
			getURL: () => APP,
			on: (e: string, l: (...a: unknown[]) => void) => {
				listeners[e] = l;
			},
			setWindowOpenHandler: vi.fn(),
			send: vi.fn(),
			session: {
				setPermissionRequestHandler: vi.fn(),
				setPermissionCheckHandler: vi.fn(),
				webRequest: { onHeadersReceived: vi.fn() },
			},
		};
		const openExternal = vi.fn();
		// biome-ignore lint/suspicious/noExplicitAny: structural fake
		installNavigationGuards(contents as any, openExternal);
		const event = {
			url: "https://evil.example/",
			isMainFrame: false,
			frame: { url: "hubble-asset://x/%2Fw/a.html" },
			preventDefault: vi.fn(),
		};
		listeners["will-frame-navigate"]?.(event);
		expect(event.preventDefault).toHaveBeenCalled();
		expect(openExternal).toHaveBeenCalledWith("https://evil.example/");
	});
});

describe("frame-ancestors * widened to the app origin", () => {
	const csp =
		"default-src 'none'; img-src https: data:; form-action 'self'; base-uri 'none'; frame-ancestors *";
	it("appends the app origin when frame-ancestors is a bare *", () => {
		const out = widenWildcardFrameAncestors(
			{ "Content-Security-Policy": [csp] },
			"app://mdly",
		);
		expect(out?.["Content-Security-Policy"]).toEqual([
			"default-src 'none'; img-src https: data:; form-action 'self'; base-uri 'none'; frame-ancestors * app://mdly",
		]);
	});
	it("leaves restrictive frame-ancestors and missing CSP untouched", () => {
		expect(
			widenWildcardFrameAncestors(
				{ "content-security-policy": ["frame-ancestors 'self' https://a.com"] },
				"app://mdly",
			),
		).toBeNull();
		expect(
			widenWildcardFrameAncestors(
				{ "x-frame-options": ["DENY"] },
				"app://mdly",
			),
		).toBeNull();
		expect(
			widenWildcardFrameAncestors(
				{
					"content-security-policy": ["frame-ancestors *; script-src *"],
					"x-frame-options": ["DENY"],
				},
				"app://mdly",
			),
		).toBeNull();
	});
	it("does not treat *.example.com as a bare wildcard", () => {
		expect(
			widenWildcardFrameAncestors(
				{ "content-security-policy": ["frame-ancestors *.example.com"] },
				"app://mdly",
			),
		).toBeNull();
	});
});
