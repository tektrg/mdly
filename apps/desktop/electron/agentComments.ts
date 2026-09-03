/**
 * Agent-facing comment operations — the transport-free core of Slice 4
 * (`docs/plans/local-doc-comments.md`). Everything here is plain data in,
 * plain data (or a thrown `Error`) out, so `agentTools.ts` (the MCP-shaped
 * adapter) and its transports never touch `@mdly/doc-comments` directly.
 *
 * This module deliberately does NOT reimplement store access: every write
 * and every per-document read delegates to `comments.ts`'s already-tested
 * `openCommentThreadForPath` / `replyToCommentThreadForPath` /
 * `resolveCommentThreadForPath` / `reopenCommentThreadForPath` /
 * `listCommentThreadsForPath`, and path→workspace resolution reuses
 * `docHistoryWiring.ts`'s `resolveHistoryWorkspaceRoot` /
 * `toWorkspaceRelativePath`. What's added here is: (1) agent-shaped
 * ergonomics `comments.ts` has no reason to offer — optional/defaulted
 * paths, whole-workspace listing, quote-anchored thread creation — and
 * (2) safety checks an autonomous caller needs that a human-driven UI
 * doesn't, most importantly the threadId existence guard in section E below.
 */
import fs from "node:fs/promises";
import nodePath from "node:path";
import {
	type AnchorStatus,
	type CommentThread,
	commentsDirPath,
	resolveAnchor,
	type TextAnchor,
	type ThreadState,
} from "@mdly/doc-comments";
import {
	historyRootFor,
	type RevisionAuthor,
	readMergedPathIndexEntries,
	replayPathIndex,
} from "@mdly/doc-history";
import { createNodeFileSystem } from "@mdly/doc-history/node";
import {
	hasLinkedNotionFrontMatter,
	normalizeNotionMarkdownBody,
	parseMarkdownFrontMatter,
} from "@mdly/workspace-kit/engine";
import { AGENT_AUTHOR_LABEL, type AgentToolContext } from "./agentToolContract";
import {
	listCommentThreadsForPath,
	openCommentThreadForPath,
	reopenCommentThreadForPath,
	replyToCommentThreadForPath,
	resolveCommentThreadForPath,
} from "./comments";
import {
	resolveHistoryWorkspaceRoot,
	toWorkspaceRelativePath,
} from "./docHistoryWiring";

/** Same constant `buildAnchor.ts` uses for its quote+context fallback (kept in sync manually — the kit's constant isn't exported). */
const QUOTE_CONTEXT_LENGTH = 40;

/** Plain Node filesystem, used only for the reads `comments.ts` has no reason to offer: listing a workspace's comment-log directory and reading a note's saved bytes. Store *writes* still go exclusively through `comments.ts`. */
const agentFileSystem = createNodeFileSystem();

/**
 * The main process has no live editor draft to replay a `revision`-mode
 * anchor against (only the renderer does — see `comments.ts`'s own note on
 * this), so revision replay is always declined here and every anchor falls
 * back to quote(+context) matching against whatever text is passed in. This
 * mirrors `comments.ts`'s `NOOP_ANCHOR_RESOLUTION_INPUTS`.
 */
const NOOP_READ_REVISION_CONTENT = async () => null;
const IDENTITY_FLATTEN = (docBody: string) => docBody;

export type AgentThreadScope = "workspace" | "open";
export type AgentThreadStateFilter = "open" | "resolved" | "all";

export interface AgentOpenDocument {
	/** Absolute path, exactly as `ctx.openDocumentPath` holds it. */
	path: string;
	/** Path relative to its granted workspace root. */
	relativePath: string;
}

/** One event in a thread, shaped for a model reader — no event ids, no `prev` chain, no anchor internals. */
export interface AgentThreadMessage {
	author: RevisionAuthor;
	kind: CommentThread["opener"]["kind"] | "replied" | "resolved" | "reopened";
	/** Empty for event kinds that carry no message body (`resolved`, `reopened`). */
	text: string;
}

export interface AgentThreadSummary {
	threadId: string;
	state: ThreadState;
	quote: string;
	anchorStatus: AnchorStatus;
	openedBy: RevisionAuthor;
	messages: AgentThreadMessage[];
}

export interface AgentDocumentThreads {
	/** Path relative to the workspace root — what a caller should pass back as `path` on a follow-up call. */
	path: string;
	threads: AgentThreadSummary[];
}

export interface ListAgentThreadsParams {
	scope?: AgentThreadScope;
	state?: AgentThreadStateFilter;
	path?: string;
}

export interface ListAgentThreadsResult {
	openDocument: AgentOpenDocument | null;
	documents: AgentDocumentThreads[];
}

export interface ListAgentDocumentsParams {
	state?: AgentThreadStateFilter;
	limit?: number;
}

export interface AgentDocumentSummary {
	/** ABSOLUTE path — the agent passes this straight back as `path` to `list_threads`. */
	path: string;
	/** Path relative to its workspace root, for display. */
	relativePath: string;
	workspaceRoot: string;
	/** True when this is the note the human currently has open. */
	isOpenDocument: boolean;
	openThreads: number;
	resolvedThreads: number;
	/** ISO timestamp — newest mtime of the note's comment log(s). */
	lastActivity: string;
	/** Newest matching thread, trimmed for browsing. `text` truncated to 200 chars with a trailing "…". */
	latestComment: {
		threadId: string;
		quote: string;
		text: string;
		by: RevisionAuthor;
	} | null;
}

export interface ListAgentDocumentsResult {
	openDocument: AgentOpenDocument | null;
	documents: AgentDocumentSummary[];
	/** True when candidates remained unexamined — the caller can raise `limit`. */
	truncated: boolean;
}

export interface ReadAgentThreadParams {
	path?: string;
	threadId: string;
}

export interface ReadAgentThreadResult {
	openDocument: AgentOpenDocument | null;
	path: string;
	thread: AgentThreadSummary;
}

export interface CreateAgentThreadParams {
	path?: string;
	quote: string;
	text: string;
}

export interface ReplyToAgentThreadParams {
	path?: string;
	threadId: string;
	text: string;
}

/** Shared shape for `resolve`/`reopen`, which need nothing beyond the target thread. */
export interface AgentThreadIdParams {
	path?: string;
	threadId: string;
}

interface ResolvedAgentPath {
	absolutePath: string;
	workspaceRoot: string;
}

/**
 * Resolves an optional agent-supplied `path` to an absolute path plus the
 * granted workspace root it lives under (D).
 *
 * - Missing `path` defaults to `ctx.openDocumentPath`; if that's also null,
 *   there is nothing to operate on and this throws rather than guessing.
 * - A relative path resolves against the single granted root when there is
 *   only one; with more than one granted root it resolves against whichever
 *   root the currently open document belongs to (the obvious "current
 *   workspace" when one exists); otherwise it's ambiguous and this throws,
 *   asking for an absolute path instead.
 * - Every resulting absolute path is checked against every granted root via
 *   `resolveHistoryWorkspaceRoot` (the same containment logic the rest of
 *   the app already trusts) before it is returned — nothing downstream ever
 *   sees a path this check didn't clear.
 */
/**
 * Resolves symlinks in `target`. A path that doesn't exist yet resolves
 * through its nearest existing ancestor, with the missing tail rejoined, so
 * this works for writes to files that aren't there yet.
 */
async function realPath(target: string): Promise<string> {
	const missingTail: string[] = [];
	let current = target;
	for (;;) {
		try {
			const resolved = await fs.realpath(current);
			return missingTail.length > 0
				? nodePath.join(resolved, ...missingTail.reverse())
				: resolved;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// ONLY "this component isn't there yet" is safe to walk past. Any
			// other failure (EACCES, ELOOP, ENAMETOOLONG, EIO) means we could
			// not learn where the path really points, and returning the
			// unresolved path would fail OPEN — straight back to the
			// string-only check this replaced. That matters because an
			// attacker who owns the workspace files can force EACCES on
			// demand by chmod-ing a directory, so a swallowed error here is a
			// deterministic bypass, not a rare edge case.
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				throw new Error(
					`Cannot verify where "${target}" really points (${code ?? "unknown error"}); refusing to touch it.`,
				);
			}
			const parent = nodePath.dirname(current);
			// Walked to the filesystem root without resolving anything: also
			// fail closed rather than trusting the literal path.
			if (parent === current) {
				throw new Error(
					`Cannot verify where "${target}" really points; refusing to touch it.`,
				);
			}
			missingTail.push(nodePath.basename(current));
			current = parent;
		}
	}
}

/**
 * The string-level containment check above is not sufficient on its own: a
 * symlink planted inside a granted root points anywhere, and every read here
 * follows symlinks. Without this, `create_thread` doubles as a file-content
 * oracle for anything the OS user can read — the quote has to match, but the
 * saved anchor context leaks the surrounding text back out through
 * `read_thread`. That is reachable by any local process holding the loopback
 * token, not just the trusted renderer, which is what makes it worth closing
 * here rather than inheriting.
 *
 * Both sides are resolved, because a granted root can legitimately BE a
 * symlink (`/tmp` -> `/private/tmp` on macOS); comparing a resolved target
 * against an unresolved root would reject perfectly valid paths.
 *
 * KNOWN RESIDUAL (deliberate, not an oversight): this checks a path and the
 * read reopens that same path later, so a file swapped for a symlink in
 * between is followed — a time-of-check/time-of-use gap. Closing it properly
 * means holding an fd across the check and the read, which is a change to
 * the shared comment-store read path rather than to this function. The gap
 * requires an attacker who can already write into the granted workspace at a
 * precise moment, and yields the same slow quote-matching oracle rather than
 * arbitrary reads. Recorded here so the next reader does not mistake this
 * function for a complete defence.
 */
async function assertRealPathInsideRoots(
	absolutePath: string,
	roots: string[],
): Promise<void> {
	const realTarget = await realPath(absolutePath);
	for (const root of roots) {
		const realRoot = await realPath(root);
		const relative = nodePath.relative(realRoot, realTarget);
		if (
			relative === "" ||
			(!relative.startsWith("..") && !nodePath.isAbsolute(relative))
		) {
			return;
		}
	}
	throw new Error(
		`"${absolutePath}" resolves, through a symlink, outside every granted workspace root.`,
	);
}

async function resolveAgentPath(
	path: string | undefined,
	ctx: AgentToolContext,
): Promise<ResolvedAgentPath> {
	const roots = [...ctx.grantedRoots];

	let candidate = path;
	if (!candidate) {
		if (!ctx.openDocumentPath) {
			throw new Error("No document is open; pass an explicit `path`.");
		}
		candidate = ctx.openDocumentPath;
	}

	const absolutePath = nodePath.isAbsolute(candidate)
		? candidate
		: resolveRelativeAgentPath(candidate, roots, ctx.openDocumentPath);

	const workspaceRoot = resolveHistoryWorkspaceRoot(absolutePath, roots);
	if (!workspaceRoot) {
		throw new Error(
			`"${absolutePath}" is outside every granted workspace root.`,
		);
	}
	await assertRealPathInsideRoots(absolutePath, roots);
	return { absolutePath, workspaceRoot };
}

function resolveRelativeAgentPath(
	relativePath: string,
	roots: string[],
	openDocumentPath: string | null,
): string {
	if (roots.length === 1) {
		return nodePath.join(roots[0], relativePath);
	}
	if (openDocumentPath) {
		const openRoot = resolveHistoryWorkspaceRoot(openDocumentPath, roots);
		if (openRoot) return nodePath.join(openRoot, relativePath);
	}
	throw new Error(
		`Cannot resolve relative path "${relativePath}": more than one workspace is granted and no document is open to disambiguate it against. Pass an absolute path instead.`,
	);
}

/** C: every read result reports what the human currently has open, so an agent never acts blind to it. */
function describeOpenDocument(ctx: AgentToolContext): AgentOpenDocument | null {
	if (!ctx.openDocumentPath) return null;
	const workspaceRoot = resolveHistoryWorkspaceRoot(
		ctx.openDocumentPath,
		ctx.grantedRoots,
	);
	return {
		path: ctx.openDocumentPath,
		relativePath: workspaceRoot
			? toWorkspaceRelativePath(workspaceRoot, ctx.openDocumentPath)
			: ctx.openDocumentPath,
	};
}

/** F: every agent write is attributed this way — never as `"human"`. */
function agentAuthor(ctx: AgentToolContext): RevisionAuthor {
	return { kind: "agent", id: ctx.actorId, label: AGENT_AUTHOR_LABEL };
}

function matchesStateFilter(
	state: ThreadState,
	filter: AgentThreadStateFilter,
): boolean {
	return filter === "all" || state === filter;
}

function eventToMessage(
	event: CommentThread["events"][number],
): AgentThreadMessage {
	return {
		author: event.by,
		kind: event.kind,
		text: "text" in event ? event.text : "",
	};
}

/**
 * H: `@mdly/doc-comments`'s `CommentThread.events` includes the opening
 * event as `events[0]` (unlike the workspace-kit's own thread type, which
 * excludes it), so naively mapping `events` to messages would show the
 * opening comment twice. Filtered out by event id here — not by trusting
 * index 0 — so this stays correct even if event ordering ever changes.
 */
function normalizeAgentThread(thread: CommentThread): AgentThreadSummary {
	const messages: AgentThreadMessage[] = [
		eventToMessage(thread.opener),
		...thread.events
			.filter((event) => event.id !== thread.opener.id)
			.map(eventToMessage),
	];
	return {
		threadId: thread.id,
		state: thread.state,
		quote: thread.opener.anchor.quote,
		anchorStatus: thread.anchorResolution.status,
		openedBy: thread.opener.by,
		messages,
	};
}

async function readRawFileText(absolutePath: string): Promise<string | null> {
	try {
		return await fs.readFile(absolutePath, "utf8");
	} catch {
		return null;
	}
}

/** Strips a saved file's raw content to the same BODY text a live editor's doc represents — mirrors `packages/workspace-kit/src/comments/buildAnchor.ts`'s own (unexported) `extractBody`, duplicated here rather than imported since the kit doesn't export it. */
function extractSavedBody(rawFileContent: string): string {
	const parsed = parseMarkdownFrontMatter(rawFileContent);
	if (parsed.type === "none") return parsed.body;
	return hasLinkedNotionFrontMatter(parsed.raw)
		? normalizeNotionMarkdownBody(parsed.body)
		: parsed.body;
}

/** Used by `createAgentThread`: a missing/unreadable file is a hard failure — there is nothing to anchor a quote against. */
async function readSavedDocumentBodyOrThrow(
	absolutePath: string,
	relativePath: string,
): Promise<string> {
	const raw = await readRawFileText(absolutePath);
	if (raw === null) {
		throw new Error(
			`Cannot read "${relativePath}": the file does not exist on disk.`,
		);
	}
	return extractSavedBody(raw);
}

/** Used when re-resolving anchor status for reads: a missing/unreadable file just means "can't improve on the fallback" rather than a hard failure — listing threads must not blow up because one note is momentarily gone. */
async function readSavedDocumentBodyOrNull(
	absolutePath: string,
): Promise<string | null> {
	const raw = await readRawFileText(absolutePath);
	return raw === null ? null : extractSavedBody(raw);
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/**
 * D: builds a quote-mode anchor for a brand-new agent-authored thread.
 *
 * WHY the offsets are computed against the SAVED body, and WHY `mode` is
 * always `"quote"`: the main process has no live editor draft to anchor
 * against — only the renderer holds that (`comments.ts` notes the same
 * limitation for its no-op anchor resolution). The kit's `"revision"` mode
 * additionally requires proving the live doc is byte-identical to a saved
 * revision (`buildAnchor.ts`'s `buildCommentAnchor`), a check this process
 * has no live doc to perform. `"quote"` mode sidesteps both problems:
 * `resolveAnchor` re-searches whatever text it's given for `quote` on every
 * read (`packages/doc-comments/src/anchor.ts`), so the offsets recorded
 * here are only a search hint, never binding truth — they can go stale
 * without ever mis-anchoring the thread onto the wrong text.
 *
 * This never guesses a position: zero occurrences of `quote` in the saved
 * body is a hard failure (most likely unsaved live-editor text this process
 * can't see), and two-or-more occurrences is also a hard failure (there is
 * no principled way to pick one without risking the wrong instance) — both
 * throw rather than write a comment anchored to a guess.
 */
function anchorForUniqueQuote(
	body: string,
	quote: string,
	relativePath: string,
): TextAnchor {
	const occurrences = countOccurrences(body, quote);
	if (occurrences === 0) {
		throw new Error(
			`Quote not found in the saved contents of "${relativePath}". It may be unsaved text — only text already saved to disk can be anchored.`,
		);
	}
	if (occurrences > 1) {
		throw new Error(
			`Quote is ambiguous: it appears ${occurrences} times in "${relativePath}". Pass a longer, unique quote.`,
		);
	}

	const from = body.indexOf(quote);
	const to = from + quote.length;
	return {
		from,
		to,
		quote,
		mode: "quote",
		contextBefore: body.slice(Math.max(0, from - QUOTE_CONTEXT_LENGTH), from),
		contextAfter: body.slice(
			to,
			Math.min(body.length, to + QUOTE_CONTEXT_LENGTH),
		),
	};
}

/**
 * `comments.ts`'s `listCommentThreadsForPath` always resolves anchors
 * against an empty string (its own doc comment explains why: the renderer
 * already re-resolves anchors against the live draft, so it deliberately
 * discards this field). That would make every thread reported to an agent
 * look permanently `"orphaned"`, regardless of whether the quote is still
 * actually there — nearly useless signal for a caller deciding whether a
 * comment still applies. This re-resolves each thread's `anchorStatus`
 * against the note's current SAVED body instead, best-effort: if the file
 * can't be read right now, the original (always-orphaned) status is left
 * as-is rather than failing the whole listing.
 */
async function resolveThreadsForDocument(
	absolutePath: string,
	ctx: AgentToolContext,
): Promise<CommentThread[]> {
	const { threads } = await listCommentThreadsForPath(
		absolutePath,
		ctx.grantedRoots,
	);
	const body = await readSavedDocumentBodyOrNull(absolutePath);
	if (body === null) return threads;

	return Promise.all(
		threads.map(async (thread) => ({
			...thread,
			anchorResolution: await resolveAnchor(
				thread.opener.anchor,
				body,
				NOOP_READ_REVISION_CONTENT,
				IDENTITY_FLATTEN,
			),
		})),
	);
}

async function documentThreadsForPath(
	absolutePath: string,
	workspaceRoot: string,
	ctx: AgentToolContext,
	stateFilter: AgentThreadStateFilter,
): Promise<AgentDocumentThreads> {
	const threads = await resolveThreadsForDocument(absolutePath, ctx);
	return {
		path: toWorkspaceRelativePath(workspaceRoot, absolutePath),
		threads: threads
			.filter((thread) => matchesStateFilter(thread.state, stateFilter))
			.map(normalizeAgentThread),
	};
}

/**
 * Derives a comment log's docId from its filename, tolerating doc-history's
 * numbered forks (`<docId> 2.jsonl`) and doc-comments' own conflict copies
 * (`<docId>.jsonl.conflict-<suffix>`) — the same two sibling patterns
 * `packages/doc-comments/src/commentLog.ts`'s `findCommentLogSiblings`
 * globs for, applied here in reverse (filename → docId) so a document with
 * a forked or conflicted log is only listed once, not once per sibling
 * file.
 */
function docIdFromCommentLogFileName(fileName: string): string | null {
	const numberedFork = /^(.+) \d+\.jsonl$/.exec(fileName);
	if (numberedFork) return numberedFork[1];
	const conflictCopy = /^(.+)\.jsonl\.conflict-.+$/.exec(fileName);
	if (conflictCopy) return conflictCopy[1];
	const canonical = /^(.+)\.jsonl$/.exec(fileName);
	return canonical ? canonical[1] : null;
}

async function listCommentLogDocIds(
	workspaceRoot: string,
): Promise<Set<string>> {
	const names = await agentFileSystem.listDir(commentsDirPath(workspaceRoot));
	const docIds = new Set<string>();
	for (const name of names) {
		const docId = docIdFromCommentLogFileName(name);
		if (docId) docIds.add(docId);
	}
	return docIds;
}

/** Inverts doc-history's path→docId index (B) so a docId found on disk can be mapped back to its current path — or found to have none, meaning the note was deleted. */
async function currentPathByDocId(
	workspaceRoot: string,
): Promise<Map<string, string>> {
	const entries = await readMergedPathIndexEntries(
		agentFileSystem,
		historyRootFor(workspaceRoot),
	);
	const byPath = replayPathIndex(entries);
	const byDocId = new Map<string, string>();
	for (const [relativePath, docId] of byPath) {
		byDocId.set(docId, relativePath);
	}
	return byDocId;
}

/** B: lists threads across every document in the workspace, skipping any comment log whose note no longer has a current path (deleted). */
async function allDocumentThreads(
	workspaceRoot: string,
	ctx: AgentToolContext,
	stateFilter: AgentThreadStateFilter,
): Promise<AgentDocumentThreads[]> {
	const [docIds, pathByDocId] = await Promise.all([
		listCommentLogDocIds(workspaceRoot),
		currentPathByDocId(workspaceRoot),
	]);

	const documents: AgentDocumentThreads[] = [];
	for (const docId of docIds) {
		const relativePath = pathByDocId.get(docId);
		if (!relativePath) continue; // note was deleted — nothing to report it against
		const absolutePath = nodePath.join(
			workspaceRoot,
			...relativePath.split("/"),
		);
		// Isolated per document on purpose: a single unreadable or
		// out-of-root entry (a tampered or half-written history index) must
		// not take down `list_threads` for the entire workspace, which is the
		// default scope. Skipping the bad document degrades the answer;
		// throwing would erase it.
		try {
			documents.push(
				await documentThreadsForPath(
					absolutePath,
					workspaceRoot,
					ctx,
					stateFilter,
				),
			);
		} catch (error) {
			console.error(
				`[agent-comments] skipped "${relativePath}" while listing the workspace:`,
				error,
			);
		}
	}
	return documents;
}

interface CommentLogCandidate {
	root: string;
	docId: string;
	mtimeMs: number;
}

/**
 * Cheap first pass for `listAgentDocuments`: stats every comment-log file
 * across every granted root (never parses one) to find, per `(root, docId)`,
 * the newest mtime among its sibling fork/conflict logs. This is what keeps
 * the whole tool's cost proportional to the number of comment-log FILES, not
 * to the cost of parsing them.
 */
async function collectCommentLogCandidates(
	roots: readonly string[],
): Promise<CommentLogCandidate[]> {
	const candidates: CommentLogCandidate[] = [];
	for (const root of roots) {
		const dir = commentsDirPath(root);
		const names = await agentFileSystem.listDir(dir);
		const newestMtimeByDocId = new Map<string, number>();
		for (const name of names) {
			const docId = docIdFromCommentLogFileName(name);
			if (!docId) continue;
			try {
				const stat = await fs.stat(nodePath.join(dir, name));
				const existing = newestMtimeByDocId.get(docId);
				if (existing === undefined || stat.mtimeMs > existing) {
					newestMtimeByDocId.set(docId, stat.mtimeMs);
				}
			} catch {
				// Vanished or unreadable between listDir and stat — not this
				// function's job to explain; the candidate is just dropped.
			}
		}
		for (const [docId, mtimeMs] of newestMtimeByDocId) {
			candidates.push({ root, docId, mtimeMs });
		}
	}
	return candidates;
}

/** Truncates a preview string to `maxLength`, appending an ellipsis when it does. */
function truncateForPreview(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * A cheap, recency-ranked index of notes that have comments — the entry
 * point for an agent that hasn't been told which note to look at yet.
 *
 * Unlike `listAgentThreads`'s `scope: "workspace"`, which parses every
 * comment log in the workspace and returns every message in full, this
 * scales with `limit`, not with the number of commented notes: it only stats
 * comment-log files to rank candidates by recency
 * (`collectCommentLogCandidates`), then parses full thread data for just the
 * newest few candidates until `limit` qualifying documents are found or the
 * candidate budget below is exhausted.
 */
export async function listAgentDocuments(
	params: ListAgentDocumentsParams,
	ctx: AgentToolContext,
): Promise<ListAgentDocumentsResult> {
	const stateFilter = params.state ?? "open";
	const limit = Math.min(50, Math.max(1, params.limit ?? 10));
	const maxCandidatesToExamine = Math.max(limit * 4, 40);

	const candidates = await collectCommentLogCandidates([...ctx.grantedRoots]);
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

	// Memoized per root, computed lazily — only roots that actually surface a
	// candidate ever pay for the path-index read.
	const pathIndexByRoot = new Map<string, Map<string, string>>();
	async function currentPathFor(
		root: string,
		docId: string,
	): Promise<string | undefined> {
		let byDocId = pathIndexByRoot.get(root);
		if (!byDocId) {
			byDocId = await currentPathByDocId(root);
			pathIndexByRoot.set(root, byDocId);
		}
		return byDocId.get(docId);
	}

	const documents: AgentDocumentSummary[] = [];
	let index = 0;
	for (; index < candidates.length; index++) {
		if (documents.length >= limit) break;
		if (index >= maxCandidatesToExamine) break;

		const candidate = candidates[index];
		const relativePath = await currentPathFor(candidate.root, candidate.docId);
		if (!relativePath) continue; // note deleted — log outlived its path-index entry

		const absolutePath = nodePath.join(
			candidate.root,
			...relativePath.split("/"),
		);
		// Isolated per candidate, matching `allDocumentThreads`'s rationale: one
		// corrupt log or an unresolvable symlink must not erase the rest of the
		// index, just that one entry.
		try {
			const resolved = await resolveAgentPath(absolutePath, ctx);
			const documentThreads = await documentThreadsForPath(
				resolved.absolutePath,
				resolved.workspaceRoot,
				ctx,
				"all",
			);
			const matching = documentThreads.threads.filter((thread) =>
				matchesStateFilter(thread.state, stateFilter),
			);
			if (matching.length === 0) continue;

			// `documentThreadsForPath` preserves the store's own thread order,
			// which is append-based (oldest opener first) — so the LAST matching
			// thread is the newest one.
			const latestThread = matching[matching.length - 1];
			// The preview quotes the thread's OPENING message, not its most
			// recent event: a resolve/reopen event carries no text, while the
			// opener is guaranteed non-empty (`assertNonEmptyText` enforces this
			// at creation time) — so this is never a blank preview.
			const openingMessage = latestThread.messages[0];

			documents.push({
				path: resolved.absolutePath,
				relativePath: documentThreads.path,
				workspaceRoot: resolved.workspaceRoot,
				isOpenDocument: resolved.absolutePath === ctx.openDocumentPath,
				openThreads: documentThreads.threads.filter(
					(thread) => thread.state === "open",
				).length,
				resolvedThreads: documentThreads.threads.filter(
					(thread) => thread.state === "resolved",
				).length,
				lastActivity: new Date(candidate.mtimeMs).toISOString(),
				latestComment: {
					threadId: latestThread.threadId,
					quote: latestThread.quote,
					text: truncateForPreview(openingMessage?.text ?? "", 200),
					by: latestThread.openedBy,
				},
			});
		} catch (error) {
			console.error(
				`[agent-comments] skipped "${relativePath}" while listing documents:`,
				error,
			);
		}
	}

	return {
		openDocument: describeOpenDocument(ctx),
		documents,
		truncated: index < candidates.length,
	};
}

/** E: `commentStore.ts` does not validate `threadId` — an unknown id silently appends a detached, invisible event chain. Every write against an existing thread must confirm it exists first. Throws a message naming both the id and the document, since an agent will hallucinate a thread id eventually. */
async function findThreadOrThrow(
	absolutePath: string,
	workspaceRoot: string,
	ctx: AgentToolContext,
	threadId: string,
): Promise<CommentThread> {
	const { threads } = await listCommentThreadsForPath(
		absolutePath,
		ctx.grantedRoots,
	);
	const thread = threads.find((candidate) => candidate.id === threadId);
	if (!thread) {
		const relativePath = toWorkspaceRelativePath(workspaceRoot, absolutePath);
		throw new Error(
			`No comment thread "${threadId}" on "${relativePath}". It may already be on a different document, or the id was invented.`,
		);
	}
	return thread;
}

function assertNonEmptyText(value: string, fieldDescription: string): void {
	if (!value || value.trim().length === 0) {
		throw new Error(`${fieldDescription} must not be empty.`);
	}
}

/** Lists comment threads. Defaults to unresolved threads on the currently open document; pass `scope: "workspace"` for a full sweep, or use `listAgentDocuments` to find which notes have comments cheaply first. See `AgentThreadScope`/`AgentThreadStateFilter` for the other options. */
export async function listAgentThreads(
	params: ListAgentThreadsParams,
	ctx: AgentToolContext,
): Promise<ListAgentThreadsResult> {
	const { absolutePath, workspaceRoot } = await resolveAgentPath(
		params.path,
		ctx,
	);
	const scope = params.scope ?? "open";
	const stateFilter = params.state ?? "open";

	const documents =
		scope === "open"
			? [
					await documentThreadsForPath(
						absolutePath,
						workspaceRoot,
						ctx,
						stateFilter,
					),
				]
			: (await allDocumentThreads(workspaceRoot, ctx, stateFilter)).filter(
					(document) => document.threads.length > 0,
				);

	return { openDocument: describeOpenDocument(ctx), documents };
}

/** Reads one thread in full, including every reply/resolve/reopen event. */
export async function readAgentThread(
	params: ReadAgentThreadParams,
	ctx: AgentToolContext,
): Promise<ReadAgentThreadResult> {
	const { absolutePath, workspaceRoot } = await resolveAgentPath(
		params.path,
		ctx,
	);
	const threads = await resolveThreadsForDocument(absolutePath, ctx);
	const thread = threads.find((candidate) => candidate.id === params.threadId);
	if (!thread) {
		const relativePath = toWorkspaceRelativePath(workspaceRoot, absolutePath);
		throw new Error(
			`No comment thread "${params.threadId}" on "${relativePath}". It may already be on a different document, or the id was invented.`,
		);
	}

	return {
		openDocument: describeOpenDocument(ctx),
		path: toWorkspaceRelativePath(workspaceRoot, absolutePath),
		thread: normalizeAgentThread(thread),
	};
}

/** D: opens a new thread anchored to a unique quote from the note's SAVED content. Throws rather than writing anywhere if the quote is missing, ambiguous, or blank, or if `text` is blank. */
export async function createAgentThread(
	params: CreateAgentThreadParams,
	ctx: AgentToolContext,
): Promise<void> {
	assertNonEmptyText(params.quote, "`quote`");
	assertNonEmptyText(params.text, "`text`");

	const { absolutePath, workspaceRoot } = await resolveAgentPath(
		params.path,
		ctx,
	);
	const relativePath = toWorkspaceRelativePath(workspaceRoot, absolutePath);
	const body = await readSavedDocumentBodyOrThrow(absolutePath, relativePath);
	const anchor = anchorForUniqueQuote(body, params.quote, relativePath);

	await openCommentThreadForPath({
		absoluteFilePath: absolutePath,
		grantedRoots: ctx.grantedRoots,
		author: agentAuthor(ctx),
		anchor,
		text: params.text,
	});
	ctx.notifyCommentsChanged(absolutePath);
}

/** E: replies to an existing thread, reopening it if it was resolved (delegated to `@mdly/doc-comments`, per `comments.ts`). Rejects — and writes nothing — if `threadId` doesn't exist on the resolved document. */
export async function replyToAgentThread(
	params: ReplyToAgentThreadParams,
	ctx: AgentToolContext,
): Promise<void> {
	assertNonEmptyText(params.text, "`text`");
	const { absolutePath, workspaceRoot } = await resolveAgentPath(
		params.path,
		ctx,
	);
	await findThreadOrThrow(absolutePath, workspaceRoot, ctx, params.threadId);

	await replyToCommentThreadForPath({
		absoluteFilePath: absolutePath,
		grantedRoots: ctx.grantedRoots,
		author: agentAuthor(ctx),
		threadId: params.threadId,
		text: params.text,
	});
	ctx.notifyCommentsChanged(absolutePath);
}

/** E: resolves a thread. Rejects — and writes nothing — if `threadId` doesn't exist on the resolved document. */
export async function resolveAgentThread(
	params: AgentThreadIdParams,
	ctx: AgentToolContext,
): Promise<void> {
	const { absolutePath, workspaceRoot } = await resolveAgentPath(
		params.path,
		ctx,
	);
	await findThreadOrThrow(absolutePath, workspaceRoot, ctx, params.threadId);

	await resolveCommentThreadForPath({
		absoluteFilePath: absolutePath,
		grantedRoots: ctx.grantedRoots,
		author: agentAuthor(ctx),
		threadId: params.threadId,
	});
	ctx.notifyCommentsChanged(absolutePath);
}

/** E: reopens a resolved thread. Rejects — and writes nothing — if `threadId` doesn't exist on the resolved document. */
export async function reopenAgentThread(
	params: AgentThreadIdParams,
	ctx: AgentToolContext,
): Promise<void> {
	const { absolutePath, workspaceRoot } = await resolveAgentPath(
		params.path,
		ctx,
	);
	await findThreadOrThrow(absolutePath, workspaceRoot, ctx, params.threadId);

	await reopenCommentThreadForPath({
		absoluteFilePath: absolutePath,
		grantedRoots: ctx.grantedRoots,
		author: agentAuthor(ctx),
		threadId: params.threadId,
	});
	ctx.notifyCommentsChanged(absolutePath);
}
