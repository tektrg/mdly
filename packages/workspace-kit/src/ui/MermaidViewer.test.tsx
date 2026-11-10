// @vitest-environment happy-dom
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clampZoom, MAX_ZOOM, MermaidViewer, MIN_ZOOM } from "./MermaidViewer";

vi.mock("@tektrg/diagram-kit/react", () => ({
	MermaidDiagram: () => <div data-testid="diagram" />,
}));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("clampZoom", () => {
	it("keeps zoom inside the limits", () => {
		expect(clampZoom(100)).toBe(MAX_ZOOM);
		expect(clampZoom(0)).toBe(MIN_ZOOM);
		expect(clampZoom(2)).toBe(2);
	});
});

describe("MermaidViewer", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	function mount(props: { onEdit?: () => void } = {}) {
		const el = document.createElement("div");
		document.body.appendChild(el);
		const root = createRoot(el);
		act(() => {
			root.render(
				<MermaidViewer
					open
					onOpenChange={() => {}}
					source="flowchart TD\n A-->B"
					onEdit={props.onEdit ?? (() => {})}
				/>,
			);
		});
		return () => act(() => root.unmount());
	}

	const click = (label: string) => {
		const button = document.querySelector<HTMLButtonElement>(
			`button[aria-label="${label}"]`,
		);
		expect(button).not.toBeNull();
		act(() => {
			button?.click();
		});
	};
	const readout = () =>
		document.querySelector("[data-mermaid-zoom]")?.textContent;

	it("zooms with the controls and resets to fit", () => {
		const unmount = mount();
		expect(readout()).toBe("100%");
		click("Zoom in");
		expect(readout()).toBe("125%");
		click("Zoom in");
		expect(readout()).toBe("156%");
		click("Zoom out");
		expect(readout()).toBe("125%");
		click("Fit to screen");
		expect(readout()).toBe("100%");
		unmount();
	});

	it("zooms with + / - / 0 keys", () => {
		const unmount = mount();
		const popup = document.querySelector(
			"[data-mermaid-viewer]",
		) as HTMLElement;
		const press = (key: string) =>
			act(() => {
				popup.dispatchEvent(
					new KeyboardEvent("keydown", { key, bubbles: true }),
				);
			});
		press("+");
		expect(readout()).toBe("125%");
		press("0");
		expect(readout()).toBe("100%");
		press("-");
		expect(readout()).toBe("80%");
		unmount();
	});

	it("hands off to the code editor", () => {
		const onEdit = vi.fn();
		const unmount = mount({ onEdit });
		const edit = [...document.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Edit code"),
		);
		act(() => edit?.click());
		expect(onEdit).toHaveBeenCalledOnce();
		unmount();
	});
});
