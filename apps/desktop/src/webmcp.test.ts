// @vitest-environment happy-dom
//
// Fakes both halves of the bridge: a fake `document.modelContext` (standing
// in for the WebMCP polyfill from `@mcp-b/global`) and a fake
// `window.desktopApi` (standing in for the main-process agent-access IPC).
// Real `@mcp-b/global` is not imported here -- these tests exercise
// webmcp.ts's own registration/teardown logic against a controllable double,
// not the polyfill itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentToolAnnotations,
	AgentToolDescriptor,
	AgentToolResult,
} from "./webmcp";

// webmcp.ts's only use of "@mcp-b/global" is its side-effecting import,
// which auto-installs a REAL BrowserMcpServer onto document.modelContext on
// import (see node_modules/@mcp-b/global/dist/index.js). That would stomp
// the fake modelContext each test installs below and spin up real
// transports in happy-dom. Stub the module out entirely so these tests
// exercise only webmcp.ts's own registration/teardown logic.
vi.mock("@mcp-b/global", () => ({}));

type RegisteredTool = {
	name: string;
	description: string;
	inputSchema: unknown;
	annotations?: AgentToolAnnotations;
	execute: (input: Record<string, unknown>) => Promise<AgentToolResult>;
};

/** A minimal stand-in for `ModelContext` that records every registration and honors the abort signal, same as the real polyfill. */
function createFakeModelContext() {
	const tools = new Map<string, RegisteredTool>();

	const registerTool = vi.fn(
		async (tool: RegisteredTool, options?: { signal?: AbortSignal }) => {
			tools.set(tool.name, tool);
			options?.signal?.addEventListener("abort", () => {
				tools.delete(tool.name);
			});
		},
	);

	return { tools, registerTool };
}

const READ_ONLY: AgentToolAnnotations = { readOnlyHint: true };
const UNTRUSTED: AgentToolAnnotations = {
	readOnlyHint: true,
	untrustedContentHint: true,
};

const DESCRIPTORS: AgentToolDescriptor[] = [
	{
		name: "mdly_list_comment_threads",
		description: "Lists comment threads on the open note.",
		inputSchema: { type: "object", properties: {} },
		annotations: UNTRUSTED,
	},
	{
		name: "mdly_open_comment_thread",
		description: "Opens a new comment thread on the open note.",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
		annotations: { readOnlyHint: false },
	},
	{
		name: "mdly_resolve_comment_thread",
		description: "Resolves a comment thread.",
		inputSchema: {
			type: "object",
			properties: { threadId: { type: "string" } },
			required: ["threadId"],
		},
		annotations: {},
	},
];

function textResult(text: string): AgentToolResult {
	return { content: [{ type: "text", text }] };
}

// Every test that reaches `loadRelayEmbed` logs a benign happy-dom stderr
// line ("JavaScript file loading is disabled") -- happy-dom refuses to
// actually fetch the injected <script src="/mcpb/embed.js">, same as a real
// browser would refuse an unreachable/blocked src. It's not a test failure,
// just what a fire-and-forget script injection looks like in this
// environment; not worth stubbing `document.createElement` to silence.
describe("webmcp bridge", () => {
	let fakeModelContext: ReturnType<typeof createFakeModelContext>;
	let getAgentAccessState: ReturnType<typeof vi.fn>;
	let listAgentTools: ReturnType<typeof vi.fn>;
	let callAgentTool: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.resetModules();
		fakeModelContext = createFakeModelContext();
		Object.defineProperty(document, "modelContext", {
			configurable: true,
			value: fakeModelContext,
		});

		getAgentAccessState = vi.fn().mockResolvedValue({
			enabled: true,
			mcpUrl: "http://127.0.0.1:5678/mcp",
			connectCommand: "claude mcp add mdly http://127.0.0.1:5678/mcp",
		});
		listAgentTools = vi.fn().mockResolvedValue(DESCRIPTORS);
		callAgentTool = vi.fn().mockResolvedValue(textResult("ok"));

		(window as unknown as { desktopApi?: unknown }).desktopApi = {
			getAgentAccessState,
			listAgentTools,
			callAgentTool,
		};

		document.body.innerHTML = "";
	});

	afterEach(() => {
		Reflect.deleteProperty(document, "modelContext");
		(window as unknown as { desktopApi?: unknown }).desktopApi = undefined;
	});

	it("registers zero tools and loads no relay embed when access is disabled", async () => {
		getAgentAccessState.mockResolvedValue({
			enabled: false,
			mcpUrl: null,
			connectCommand: null,
		});
		const { setupWebmcpBridge } = await import("./webmcp");

		const result = await setupWebmcpBridge();

		expect(result).toBe(false);
		expect(fakeModelContext.registerTool).not.toHaveBeenCalled();
		expect(document.querySelector('script[src="/mcpb/embed.js"]')).toBeNull();
	});

	it("registers every descriptor when access is enabled", async () => {
		const { setupWebmcpBridge } = await import("./webmcp");

		const result = await setupWebmcpBridge();

		expect(result).toBe(true);
		// One tool per descriptor, plus the built-in mdly_origin_probe.
		expect(fakeModelContext.tools.size).toBe(DESCRIPTORS.length + 1);
		for (const descriptor of DESCRIPTORS) {
			expect(fakeModelContext.tools.has(descriptor.name)).toBe(true);
		}
		expect(fakeModelContext.tools.has("mdly_origin_probe")).toBe(true);
		expect(
			document.querySelector('script[src="/mcpb/embed.js"]'),
		).not.toBeNull();
	});

	it("passes each descriptor's annotations through registration unchanged", async () => {
		const { setupWebmcpBridge } = await import("./webmcp");

		await setupWebmcpBridge();

		for (const descriptor of DESCRIPTORS) {
			const registered = fakeModelContext.tools.get(descriptor.name);
			expect(registered?.annotations).toEqual(descriptor.annotations);
		}
		expect(
			fakeModelContext.tools.get("mdly_origin_probe")?.annotations,
		).toEqual(READ_ONLY);
	});

	it("forwards execute to callAgentTool with the tool's name and input", async () => {
		const { setupWebmcpBridge } = await import("./webmcp");
		await setupWebmcpBridge();

		const registered = fakeModelContext.tools.get("mdly_open_comment_thread");
		const input = { text: "looks good" };
		await registered?.execute(input);

		expect(callAgentTool).toHaveBeenCalledWith(
			"mdly_open_comment_thread",
			input,
		);
	});

	it("loads the relay embed only once across repeated setup calls", async () => {
		const { setupWebmcpBridge } = await import("./webmcp");

		await setupWebmcpBridge();
		await setupWebmcpBridge();

		expect(
			document.querySelectorAll('script[src="/mcpb/embed.js"]').length,
		).toBe(1);
	});

	it("teardownWebmcpBridge aborts registration, unregistering every tool", async () => {
		const { setupWebmcpBridge, teardownWebmcpBridge } = await import(
			"./webmcp"
		);
		await setupWebmcpBridge();
		expect(fakeModelContext.tools.size).toBeGreaterThan(0);

		teardownWebmcpBridge();

		expect(fakeModelContext.tools.size).toBe(0);
	});

	it("returns false without throwing when document.modelContext is missing", async () => {
		Reflect.deleteProperty(document, "modelContext");
		const { setupWebmcpBridge } = await import("./webmcp");

		await expect(setupWebmcpBridge()).resolves.toBe(false);
		expect(fakeModelContext.registerTool).not.toHaveBeenCalled();
	});

	it("returns false without throwing when desktopApi is absent entirely", async () => {
		(window as unknown as { desktopApi?: unknown }).desktopApi = undefined;
		const { setupWebmcpBridge } = await import("./webmcp");

		await expect(setupWebmcpBridge()).resolves.toBe(false);
	});
});
