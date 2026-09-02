// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentAccessSettings } from "./AgentAccessSettings";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { getAgentAccessState, setAgentAccessEnabled } = vi.hoisted(() => ({
	getAgentAccessState: vi.fn(),
	setAgentAccessEnabled: vi.fn(),
}));

vi.mock("../desktopApi", () => ({
	desktopApi: {
		getAgentAccessState,
		setAgentAccessEnabled,
	},
}));

const { setupWebmcpBridge, teardownWebmcpBridge } = vi.hoisted(() => ({
	setupWebmcpBridge: vi.fn(),
	teardownWebmcpBridge: vi.fn(),
}));

vi.mock("../webmcp", () => ({
	setupWebmcpBridge,
	teardownWebmcpBridge,
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const ENABLED_WITH_COMMAND = {
	enabled: true,
	mcpUrl: "http://127.0.0.1:5678/mcp",
	connectCommand:
		"claude mcp add --transport http mdly http://127.0.0.1:5678/mcp",
};

const ENABLED_NO_COMMAND = {
	enabled: true,
	mcpUrl: null,
	connectCommand: null,
};

const DISABLED = {
	enabled: false,
	mcpUrl: null,
	connectCommand: null,
};

async function flushMicrotasks() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("AgentAccessSettings", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);

		getAgentAccessState.mockReset();
		setAgentAccessEnabled.mockReset();
		setupWebmcpBridge.mockReset();
		teardownWebmcpBridge.mockReset();
		setupWebmcpBridge.mockResolvedValue(true);

		// happy-dom exposes `navigator.clipboard` as a getter-only accessor, so
		// a plain Object.assign throws -- redefine the property instead.
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: vi.fn() },
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	async function renderSettings() {
		await act(async () => {
			root.render(<AgentAccessSettings />);
			await flushMicrotasks();
		});
	}

	function checkbox(): HTMLInputElement {
		const input = container.querySelector('input[type="checkbox"]');
		if (!(input instanceof HTMLInputElement)) {
			throw new Error("checkbox not found");
		}
		return input;
	}

	it("renders with the toggle checked when enabled", async () => {
		getAgentAccessState.mockResolvedValue(ENABLED_WITH_COMMAND);

		await renderSettings();

		expect(checkbox().checked).toBe(true);
		expect(checkbox().disabled).toBe(false);
	});

	it("toggling calls setAgentAccessEnabled(false)", async () => {
		getAgentAccessState.mockResolvedValue(ENABLED_WITH_COMMAND);
		setAgentAccessEnabled.mockResolvedValue(DISABLED);

		await renderSettings();

		await act(async () => {
			checkbox().click();
			await flushMicrotasks();
		});

		expect(setAgentAccessEnabled).toHaveBeenCalledWith(false);
		expect(teardownWebmcpBridge).toHaveBeenCalled();
		expect(checkbox().checked).toBe(false);
	});

	it("shows the connect command when present", async () => {
		getAgentAccessState.mockResolvedValue(ENABLED_WITH_COMMAND);

		await renderSettings();

		const field = container.querySelector(
			'input[aria-label="Connect command"]',
		);
		expect(field).toBeTruthy();
		expect((field as HTMLInputElement).value).toBe(
			ENABLED_WITH_COMMAND.connectCommand,
		);
	});

	it("shows nothing for the connect command when it is null", async () => {
		getAgentAccessState.mockResolvedValue(ENABLED_NO_COMMAND);

		await renderSettings();

		const field = container.querySelector(
			'input[aria-label="Connect command"]',
		);
		expect(field).toBeNull();
	});

	it("renders an inline error instead of throwing when the fetch rejects", async () => {
		getAgentAccessState.mockRejectedValue(
			new Error("agent access unavailable"),
		);

		await expect(renderSettings()).resolves.not.toThrow();

		expect(container.textContent).toContain("agent access unavailable");
	});

	it("gives the copy button an accessible name", async () => {
		getAgentAccessState.mockResolvedValue(ENABLED_WITH_COMMAND);

		await renderSettings();

		const copyButton = container.querySelector(
			'button[aria-label="Copy connect command"]',
		);
		expect(copyButton).toBeTruthy();
	});
});
