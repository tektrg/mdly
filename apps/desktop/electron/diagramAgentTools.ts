/**
 * Diagram tools from `@tektrg/diagram-kit` (validateDiagram, listDiagramTypes),
 * adapted onto mdly's agent tool contract so they publish over the same
 * transports as the comment tools (see `agentToolContract.ts`). The package
 * owns names, descriptions, schemas and handlers; this file only wraps them.
 */
import { agentTools as diagramKitTools } from "@tektrg/diagram-kit";
import {
	type AgentTool,
	type AgentToolInputSchema,
	errorResult,
	textResult,
} from "./agentToolContract";

type DiagramKitTool = (typeof diagramKitTools)[number];

function toAgentTool(spec: DiagramKitTool): AgentTool {
	return {
		name: spec.name,
		description: spec.description,
		inputSchema: spec.inputSchema as unknown as AgentToolInputSchema,
		// Pure, local, no document access. `untrustedContentHint` follows the
		// contract's rule for read-only tools: results echo agent-supplied source.
		annotations: { readOnlyHint: true, untrustedContentHint: true },
		async execute(input) {
			try {
				const result = spec.handler(input) as Record<string, unknown>;
				return textResult(JSON.stringify(result, null, 2), result);
			} catch (error) {
				return errorResult(
					error instanceof Error ? error.message : String(error),
				);
			}
		},
	};
}

export const DIAGRAM_AGENT_TOOLS: AgentTool[] =
	diagramKitTools.map(toAgentTool);
