/**
 * Main-process side of the agent hook (`@mdly/agent-hook`). `main.ts` and the
 * agent tools call these; each resolves an absolute doc path to its granted
 * workspace root + relative path and appends to the doc's event file, which
 * `mdly watch` tails. No Electron imports, so it is unit-testable.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
	appendHookEvent,
	createProposalReader,
	type EditProposal,
	formatWordDiff,
	type HookEventType,
	type HookOrigin,
	listLiveSubscribers,
	newHookEvent,
	readSeen,
	type Subscriber,
	wordChanges,
	writeSeen,
} from "@mdly/agent-hook";
import { resolveHistoryWorkspaceRoot } from "./docHistoryWiring";

export interface HookTarget {
	workspaceRoot: string;
	doc: string;
}

export function resolveHookTarget(
	absoluteFilePath: string,
	grantedRoots: Iterable<string>,
): HookTarget {
	const workspaceRoot = resolveHistoryWorkspaceRoot(
		absoluteFilePath,
		grantedRoots,
	);
	if (!workspaceRoot) {
		throw new Error(`No granted workspace root for: ${absoluteFilePath}`);
	}
	return { workspaceRoot, doc: path.relative(workspaceRoot, absoluteFilePath) };
}

export async function emitHookEvent(
	target: HookTarget,
	type: HookEventType,
	origin: HookOrigin,
	payload: Record<string, unknown> = {},
): Promise<void> {
	await appendHookEvent(
		target.workspaceRoot,
		newHookEvent(type, target.doc, origin, payload),
	);
}

export type SendEditsResult =
	| { status: "sent"; changes: number }
	| { status: "unchanged" };

/**
 * The explicit "send edits to agent" action: word diff of `markdown` against
 * the version the agent last saw, then that version becomes `markdown`.
 * Typing alone never calls this.
 */
export async function sendEditsToAgent(
	target: HookTarget,
	markdown: string,
): Promise<SendEditsResult> {
	const seen = (await readSeen(target.workspaceRoot, target.doc)) ?? "";
	const changes = wordChanges(seen, markdown);
	if (changes.length === 0) return { status: "unchanged" };
	await emitHookEvent(target, "doc.edited", "user", {
		diff: formatWordDiff(seen, markdown),
		changes: changes.map(({ before, after }) => ({ before, after })),
	});
	await writeSeen(target.workspaceRoot, target.doc, markdown);
	return { status: "sent", changes: changes.length };
}

export async function proposeEdit(
	target: HookTarget,
	input: { find: string; replace: string; note?: string; author: string },
): Promise<EditProposal> {
	if (!input.find)
		throw new Error('"find" must be non-empty visible text from the note.');
	if (input.find === input.replace)
		throw new Error("The proposal changes nothing.");
	const proposal: EditProposal = {
		proposalId: randomUUID().slice(0, 12),
		find: input.find,
		replace: input.replace,
		note: input.note,
		author: input.author,
	};
	await emitHookEvent(target, "edit.proposed", "agent", { ...proposal });
	return proposal;
}

// The app polls every open note; this reads only appended bytes each time.
const proposalReader = createProposalReader();

export async function listPendingProposals(
	target: HookTarget,
): Promise<EditProposal[]> {
	return proposalReader.read(target.workspaceRoot, target.doc);
}

export async function listWatchers(target: HookTarget): Promise<Subscriber[]> {
	return listLiveSubscribers(target.workspaceRoot, target.doc);
}
