/**
 * Agent-hook write-back tools. An agent never overwrites a note: `propose_edit`
 * records a suggestion the human reviews inline (accept/reject). Replying to
 * and resolving comments reuse the existing `reply`/`resolve` tools.
 */
import { resolveAgentPath } from "./agentComments";
import {
	listPendingProposals,
	proposeEdit,
	resolveHookTarget,
} from "./agentHookWiring";
import {
	AGENT_AUTHOR_LABEL,
	type AgentTool,
	errorResult,
	textResult,
} from "./agentToolContract";

function str(
	input: Record<string, unknown>,
	key: string,
	required: boolean,
): string | undefined {
	const value = input[key];
	if (value === undefined || value === null) {
		if (required) throw new Error(`"${key}" is required.`);
		return undefined;
	}
	if (typeof value !== "string") throw new Error(`"${key}" must be a string.`);
	return value;
}

function num(input: Record<string, unknown>, key: string): number | undefined {
	const value = input[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number") throw new Error(`"${key}" must be a number.`);
	return value;
}

export const PROPOSE_EDIT_TOOL: AgentTool = {
	name: "propose_edit",
	description:
		"Proposes an edit to a note as a suggestion the human accepts or rejects inline (red strike-through / green insert). Never changes the file directly. `find` must be exact visible text from ONE paragraph (rendered text, no Markdown syntax) and must be unique in the note, or name which match with `occurrence`; an ambiguous or unmatched `find` is rejected (the outcome arrives as suggestion.rejected with a `reason`). `replace` is plain text. `path` defaults to the open note. Watch the outcome with `mdly watch`: suggestion.accepted (all changes taken), suggestion.partially_accepted (some; see acceptedChanges/rejectedChanges) or suggestion.rejected.",
	inputSchema: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description:
					"Note path, relative to the workspace root or absolute. Defaults to the open note.",
			},
			find: {
				type: "string",
				description: "Exact visible text to replace, within one paragraph.",
			},
			replace: { type: "string", description: "Replacement text (plain)." },
			occurrence: {
				type: "integer",
				minimum: 1,
				description:
					"Which match of `find` to replace (1-based, in document order). Required when `find` appears more than once; otherwise the proposal is rejected as ambiguous.",
			},
			note: {
				type: "string",
				description: "Optional one-line reason shown to the human.",
			},
		},
		required: ["find", "replace"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false },
	async execute(input, ctx) {
		try {
			const { absolutePath } = await resolveAgentPath(
				str(input, "path", false),
				ctx,
			);
			const target = resolveHookTarget(absolutePath, ctx.grantedRoots);
			const proposal = await proposeEdit(target, {
				find: str(input, "find", true) ?? "",
				replace: str(input, "replace", true) ?? "",
				note: str(input, "note", false),
				occurrence: num(input, "occurrence"),
				author: AGENT_AUTHOR_LABEL,
			});
			ctx.notifySuggestionsChanged?.(absolutePath);
			const pending = await listPendingProposals(target);
			return textResult(
				`Proposed as suggestion "${proposal.proposalId}" (${pending.length} pending on this note). The human will accept or reject it.`,
				{ proposalId: proposal.proposalId },
			);
		} catch (error) {
			return errorResult(
				error instanceof Error ? error.message : String(error),
			);
		}
	},
};
