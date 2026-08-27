// WebMCP spike adapter — slice 3 of docs/plans/local-doc-comments.md.
//
// This is the page side of the WebMCP bridge. It proves the packaged renderer
// can expose tools through @mcp-b/webmcp-local-relay now that it runs on a
// privileged scheme (app://mdly) instead of file://.
//
// Responsibilities:
//   - import @mcp-b/global — installs the WebMCP polyfill on BOTH
//     document.modelContext and navigator.modelContext (older docs used the
//     navigator surface; shim both).
//   - register one trivial probe tool on document.modelContext.
//   - load the relay embed script, which discovers this page's tools and
//     relays them to a locally running @mcp-b/webmcp-local-relay MCP server.
//
// This is intentionally a spike: the tool surface reflects the open document
// and must be replaced by the real comment tools in slice 4.
import "@mcp-b/global";

const RELAY_EMBED_SRC = "/mcpb/embed.js";

type ModelContextLike = {
	registerTool: (tool: {
		name: string;
		description: string;
		inputSchema: { type: "object"; properties: Record<string, never> };
		execute: () => Promise<unknown>;
	}) => Promise<void>;
};

function currentModelContext(): ModelContextLike | undefined {
	const viaDocument = document.modelContext as ModelContextLike | undefined;
	if (viaDocument?.registerTool) return viaDocument;
	const viaNavigator = navigator.modelContext as ModelContextLike | undefined;
	if (viaNavigator?.registerTool) return viaNavigator;
	return undefined;
}

function loadRelayEmbed(): void {
	const script = document.createElement("script");
	script.src = RELAY_EMBED_SRC;
	script.async = true;
	document.body.appendChild(script);
}

/**
 * Registers one trivial WebMCP tool and wires the local relay embed.
 *
 * The probe returns the renderer's origin and secure-context status, which is
 * exactly what the spike needs to prove pass conditions 2 and 3 from inside
 * the page. Returns true when the polyfill is present and the tool was
 * registered, false otherwise (caller decides whether that's fatal).
 */
export async function setupWebmcpSpikeProbe(): Promise<boolean> {
	const context = currentModelContext();
	if (!context) {
		console.warn(
			"[webmcp] modelContext unavailable — WebMCP polyfill did not install",
		);
		return false;
	}

	await context.registerTool({
		name: "mdly_origin_probe",
		description:
			"Reports the mdly renderer's window.origin and secure-context status.",
		inputSchema: { type: "object", properties: {} },
		async execute() {
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
		},
	});

	loadRelayEmbed();
	return true;
}
