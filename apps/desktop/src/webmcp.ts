// WebMCP bridge — "Plug B" of slice 4 (docs/plans/local-doc-comments.md).
//
// This is the page side of the WebMCP bridge: it publishes the agent tool
// table the main process owns (apps/desktop/electron/agentToolContract.ts +
// agentTools.ts) onto document.modelContext, so a WebMCP-aware agent running
// inside this renderer can discover and call them. It supersedes the slice-3
// spike (setupWebmcpSpikeProbe), which only proved the plumbing with one
// throwaway probe tool.
//
// Responsibilities:
//   - import @mcp-b/global — installs the WebMCP polyfill on BOTH
//     document.modelContext and navigator.modelContext (older docs used the
//     navigator surface; shim both).
//   - ask the main process whether the user has turned agent access on, and
//     bail out registering nothing when they haven't. The Settings toggle
//     (AgentAccessSettings.tsx) is the only thing that flips this, and it
//     must genuinely gate the tool surface, not just hide a UI affordance.
//   - fetch the tool table (electron/agentToolContract.ts's AgentToolDescriptor
//     list) and register every entry, with its `annotations` passed through
//     unchanged. `readOnlyHint`/`untrustedContentHint` are what let a WebMCP
//     client treat comment/document text as data instead of instructions
//     (see agentToolContract.ts's `untrustedBlock`) — dropping them here would
//     silently undo that protection for this one transport.
//   - register everything under one AbortSignal so the whole surface can be
//     torn down without a page reload when the toggle flips back off.
//   - load the relay embed script, which discovers this page's tools and
//     relays them to a locally running @mcp-b/webmcp-local-relay MCP server.
import "@mcp-b/global";

const RELAY_EMBED_SRC = "/mcpb/embed.js";

// ---- Local mirrors of the desktopApi surface this bridge depends on -----
//
// The main-process wiring (getAgentAccessState/listAgentTools/callAgentTool)
// is landing in `desktopApi/types.ts` in a separate, concurrent edit. Rather
// than depend on that file's shape mid-flight, this module declares its own
// structural copies — kept in sync by hand, same as any other IPC contract
// mirrored across a process boundary. They intentionally match
// `apps/desktop/electron/agentToolContract.ts` field-for-field.

/** Mirrors `AgentToolAnnotations` in `electron/agentToolContract.ts`. */
export interface AgentToolAnnotations {
	readOnlyHint?: boolean;
	untrustedContentHint?: boolean;
}

/** Mirrors `AgentToolInputSchema` in `electron/agentToolContract.ts`. */
export interface AgentToolInputSchema {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties?: boolean;
}

/** Mirrors `AgentToolDescriptor` in `electron/agentToolContract.ts`. */
export interface AgentToolDescriptor {
	name: string;
	description: string;
	inputSchema: AgentToolInputSchema;
	annotations: AgentToolAnnotations;
}

/** Mirrors `AgentToolResult` in `electron/agentToolContract.ts`. */
export interface AgentToolResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/** Mirrors the resolved shape of `desktopApi.getAgentAccessState()`. */
export interface AgentAccessState {
	enabled: boolean;
	mcpUrl: string | null;
	connectCommand: string | null;
}

/**
 * The slice of `desktopApi` this bridge calls. Declared locally (not
 * imported from `desktopApi/types.ts`) so this file typechecks independently
 * of when those methods land there.
 */
interface DesktopAgentAccessApi {
	getAgentAccessState: () => Promise<AgentAccessState>;
	listAgentTools: () => Promise<AgentToolDescriptor[]>;
	callAgentTool: (
		name: string,
		input: Record<string, unknown>,
	) => Promise<AgentToolResult>;
}

/**
 * Reads the three agent-access methods off `window.desktopApi` without
 * trusting they exist: `window.desktopApi` is absent in a plain browser tab
 * and in this file's own tests, and even inside the packaged app it may
 * predate this slice's preload changes. `window` is cast through `unknown`
 * rather than through the app-wide `DesktopApi` type so this check works
 * regardless of whether that type has been updated yet.
 */
function desktopAgentAccessApi(): DesktopAgentAccessApi | undefined {
	const api = (
		window as unknown as { desktopApi?: Partial<DesktopAgentAccessApi> }
	).desktopApi;
	if (
		typeof api?.getAgentAccessState !== "function" ||
		typeof api.listAgentTools !== "function" ||
		typeof api.callAgentTool !== "function"
	) {
		return undefined;
	}
	return api as DesktopAgentAccessApi;
}

/**
 * The hand-rolled subset of `@mcp-b/webmcp-types`' `ModelContext` this file
 * needs. The real type (`node_modules/@mcp-b/webmcp-types`) additionally
 * supports a `signal` in `registerTool`'s second argument — that is the
 * mechanism `teardownWebmcpBridge` relies on to unregister everything at
 * once, so it is load-bearing here, not decoration.
 */
type ModelContextLike = {
	registerTool: (
		tool: {
			name: string;
			description: string;
			inputSchema: AgentToolInputSchema;
			annotations?: AgentToolAnnotations;
			execute: (input: Record<string, unknown>) => Promise<AgentToolResult>;
		},
		options?: { signal?: AbortSignal },
	) => Promise<void>;
};

function currentModelContext(): ModelContextLike | undefined {
	const viaDocument = document.modelContext as ModelContextLike | undefined;
	if (viaDocument?.registerTool) return viaDocument;
	const viaNavigator = navigator.modelContext as ModelContextLike | undefined;
	if (viaNavigator?.registerTool) return viaNavigator;
	return undefined;
}

// Loaded at most once per page lifetime, even across repeated
// enable → disable → enable cycles from the Settings toggle — the embed
// script self-registers with the relay on load, and re-injecting it would
// either duplicate that registration or race it.
let relayEmbedLoaded = false;

function loadRelayEmbed(): void {
	if (relayEmbedLoaded) return;
	relayEmbedLoaded = true;
	const script = document.createElement("script");
	script.src = RELAY_EMBED_SRC;
	script.async = true;
	document.body.appendChild(script);
}

/**
 * Reports the renderer's own origin and secure-context status. Kept from the
 * slice-3 spike: it is the only way to verify the privileged-scheme
 * foundation (app://mdly, not file://) from inside a packaged build, so it
 * stays even though the real comment tools now cover the rest of the surface.
 */
function originProbeDescriptor(): AgentToolDescriptor {
	return {
		name: "mdly_origin_probe",
		description:
			"Reports the mdly renderer's window.origin and secure-context status.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
	};
}

async function originProbeExecute(): Promise<AgentToolResult> {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					origin: window.location.origin,
					isSecureContext: window.isSecureContext,
					href: window.location.href,
				}),
			},
		],
	};
}

type ExecutableTool = {
	descriptor: AgentToolDescriptor;
	execute: (input: Record<string, unknown>) => Promise<AgentToolResult>;
};

/**
 * Registers every tool through one path so "annotations survive
 * registration unchanged" is true by construction rather than by convention
 * repeated at each call site.
 */
async function registerAll(
	context: ModelContextLike,
	tools: ExecutableTool[],
	signal: AbortSignal,
): Promise<void> {
	for (const tool of tools) {
		await context.registerTool(
			{
				name: tool.descriptor.name,
				description: tool.descriptor.description,
				inputSchema: tool.descriptor.inputSchema,
				annotations: tool.descriptor.annotations,
				execute: tool.execute,
			},
			{ signal },
		);
	}
}

// The one live registration, so a second setup call or a later teardown call
// always acts on the current set of tools rather than an earlier one.
let activeRegistration: AbortController | undefined;

/**
 * Registers the full agent tool table on `document.modelContext` and starts
 * the relay embed, gated entirely on the user's "Allow AI agents to read and
 * comment on this workspace" setting (AgentAccessSettings.tsx). Returns
 * false — without registering anything or loading the embed — whenever the
 * setting is off, the WebMCP polyfill isn't present, or `desktopApi` doesn't
 * yet expose the agent-access methods; every failure path here is meant to
 * leave the app running normally, never to throw.
 */
export async function setupWebmcpBridge(): Promise<boolean> {
	const api = desktopAgentAccessApi();
	if (!api) {
		console.warn(
			"[webmcp] desktopApi agent-access methods unavailable — skipping bridge setup",
		);
		return false;
	}

	let state: AgentAccessState;
	try {
		state = await api.getAgentAccessState();
	} catch (error) {
		console.warn("[webmcp] failed to read agent access state", error);
		return false;
	}

	if (!state.enabled) return false;

	const context = currentModelContext();
	if (!context) {
		console.warn(
			"[webmcp] modelContext unavailable — WebMCP polyfill did not install",
		);
		return false;
	}

	let descriptors: AgentToolDescriptor[];
	try {
		descriptors = await api.listAgentTools();
	} catch (error) {
		console.warn("[webmcp] failed to list agent tools", error);
		return false;
	}

	// Re-running setup (e.g. the toggle flipped off then on again) replaces
	// the previous registration rather than layering on top of it.
	activeRegistration?.abort();
	const controller = new AbortController();
	activeRegistration = controller;

	const tools: ExecutableTool[] = [
		{ descriptor: originProbeDescriptor(), execute: originProbeExecute },
		...descriptors.map((descriptor) => ({
			descriptor,
			execute: (input: Record<string, unknown>) =>
				api.callAgentTool(descriptor.name, input),
		})),
	];

	await registerAll(context, tools, controller.signal);
	loadRelayEmbed();
	return true;
}

/**
 * Unregisters every tool this bridge registered, by aborting the shared
 * signal. This is what lets the Settings toggle turn the agent surface off
 * immediately, with no app restart. Safe to call when nothing is registered.
 */
export function teardownWebmcpBridge(): void {
	activeRegistration?.abort();
	activeRegistration = undefined;
}
