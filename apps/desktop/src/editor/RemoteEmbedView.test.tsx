// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import type { NodeViewProps } from "@tiptap/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let failListener:
	| ((e: { url: string; errorCode: number; errorDescription: string }) => void)
	| null = null;
const openExternalUrl = vi.fn(async (_url: string) => {});
vi.mock("../desktopApi", () => ({
	desktopApi: {
		platform: "darwin",
		openExternalUrl: (url: string) => openExternalUrl(url),
		onEmbedLoadFailed: (cb: typeof failListener) => {
			failListener = cb;
			return () => {
				failListener = null;
			};
		},
	},
}));

const { RemoteEmbedView, REMOTE_EMBED_SANDBOX, embedHeightPx, embedWidthCss } =
	await import("./RemoteEmbedView");

const RAW =
	'<iframe src="https://www.youtube.com/embed/abc" title="Video" width="560" height="315" allow="autoplay; encrypted-media" allowfullscreen></iframe>';

let container: HTMLElement;
let root: Root | null = null;
beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container.remove();
	document.body.innerHTML = "";
});

function render(raw = RAW) {
	const updateAttributes = vi.fn();
	const props = {
		node: {
			attrs: {
				src: "https://www.youtube.com/embed/abc",
				raw,
				width: "560",
				height: "315",
			},
		},
		selected: false,
		updateAttributes,
		editor: { isEditable: true },
	} as unknown as NodeViewProps;
	act(() => {
		root = createRoot(container);
		root.render(<RemoteEmbedView {...props} />);
	});
	return { updateAttributes };
}

describe("RemoteEmbedView", () => {
	it("shows the host once when the iframe has no title", () => {
		render('<iframe src="https://www.youtube.com/embed/abc"></iframe>');
		const bar = container.querySelector(".hubble-remote-embed-bar");
		expect(bar?.textContent?.split("www.youtube.com").length).toBe(2);
	});

	it("renders a lazy, sandboxed iframe without the html-app token", () => {
		render();
		const frame = container.querySelector("iframe");
		expect(frame?.getAttribute("sandbox")).toBe(REMOTE_EMBED_SANDBOX);
		expect(REMOTE_EMBED_SANDBOX).not.toContain("allow-top-navigation");
		expect(frame?.getAttribute("loading")).toBe("lazy");
		expect(frame?.getAttribute("name")).toBeNull();
		expect(frame?.getAttribute("allow")).toBe("autoplay; encrypted-media");
		expect(frame?.hasAttribute("allowfullscreen")).toBe(true);
		expect(frame?.style.blockSize).toBe("315px");
	});

	it("shows a fallback card with Open in browser when the frame fails", async () => {
		render();
		await act(async () => {
			failListener?.({
				url: "https://www.youtube.com/embed/abc",
				errorCode: -27,
				errorDescription: "ERR_BLOCKED_BY_RESPONSE",
			});
		});
		expect(container.querySelector("iframe")).toBeNull();
		expect(container.textContent).toContain(
			"https://www.youtube.com/embed/abc",
		);
		const button = [...container.querySelectorAll("button")].find(
			(b) => b.textContent === "Open in browser",
		);
		await act(async () => button?.click());
		expect(openExternalUrl).toHaveBeenCalledWith(
			"https://www.youtube.com/embed/abc",
		);
	});

	it("right-click on the chrome offers the embed menu", async () => {
		render();
		const bar = container.querySelector(".hubble-remote-embed-bar");
		await act(async () => {
			bar?.dispatchEvent(
				new MouseEvent("contextmenu", {
					bubbles: true,
					clientX: 5,
					clientY: 5,
				}),
			);
		});
		const text = document.body.textContent ?? "";
		for (const label of [
			"View full screen",
			"Copy URL",
			"Open in browser",
			"Reload",
		]) {
			expect(text).toContain(label);
		}
	});

	it("dragging the bottom handle writes the new height", async () => {
		const { updateAttributes } = render();
		const handle = container.querySelector<HTMLElement>(
			".hubble-remote-embed-resize",
		);
		if (!handle) throw new Error("no handle");
		handle.setPointerCapture = () => {};
		await act(async () => {
			handle.dispatchEvent(
				new PointerEvent("pointerdown", {
					bubbles: true,
					button: 0,
					clientY: 100,
				}),
			);
		});
		await act(async () => {
			handle.dispatchEvent(
				new PointerEvent("pointermove", { bubbles: true, clientY: 185 }),
			);
		});
		await act(async () => {
			handle.dispatchEvent(
				new PointerEvent("pointerup", { bubbles: true, clientY: 185 }),
			);
		});
		expect(updateAttributes).toHaveBeenCalledWith({ height: "400" });
	});

	it("maps width/height attributes to CSS", () => {
		expect(embedWidthCss("100%")).toBe("100%");
		expect(embedWidthCss("550")).toBe("550px");
		expect(embedWidthCss(null)).toBe("100%");
		expect(embedHeightPx("800")).toBe(800);
		expect(embedHeightPx("100%")).toBe(400);
	});
});
