/**
 * Wiring between the three existing write hooks (in-app save, external-file
 * watcher, rename) and `@mdly/doc-history`. Pulled out of `main.ts` — which
 * only registers IPC handlers and delegates — so this logic is unit
 * testable without standing up a real Electron app, matching the pattern
 * already used for `fileDiscovery.ts`/`docImport.ts`/`notion.ts`.
 *
 * Every exported "record*History" function swallows its own errors (logging
 * them) rather than throwing, so a history-recording failure can never break
 * the real file write/rename it rides alongside (R29).
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
	contentHash,
	createHistoryStore,
	type DocHistoryStore,
	isVersionableMarkdownPath,
	type RevisionAuthor,
	type RevisionCause,
} from "@mdly/doc-history";
import {
	createGzipCompressor,
	createNodeFileSystem,
} from "@mdly/doc-history/node";

/** In-app saves are never tagged 'external-write' — that cause is reserved for the watcher hook (R13). */
export type InAppHistoryCause = Exclude<RevisionCause, "external-write">;

const historyStoresByWorkspaceRoot = new Map<string, DocHistoryStore>();

/** One store instance per workspace root, created lazily and reused (cheap — no I/O until first use). */
export function getHistoryStoreForWorkspace(
	workspaceRoot: string,
): DocHistoryStore {
	let store = historyStoresByWorkspaceRoot.get(workspaceRoot);
	if (!store) {
		store = createHistoryStore({
			fs: createNodeFileSystem(),
			compressor: createGzipCompressor(),
			workspaceRoot,
		});
		historyStoresByWorkspaceRoot.set(workspaceRoot, store);
	}
	return store;
}

/**
 * Resolves which currently-granted root a file belongs to, purely from the
 * file's own absolute path — never from a separately-tracked "current
 * workspace" pointer. This is what keeps a forced cut correctly filed under
 * a file's true originating workspace even mid-workspace-switch (R41): the
 * caller passes the path the edit actually belongs to, and this function's
 * answer depends on nothing else that could have changed since.
 */
export function resolveHistoryWorkspaceRoot(
	absoluteFilePath: string,
	grantedRoots: Iterable<string>,
): string | null {
	let best: string | null = null;
	for (const root of grantedRoots) {
		const relative = path.relative(root, absoluteFilePath);
		const isInside =
			relative === "" ||
			(!relative.startsWith("..") && !path.isAbsolute(relative));
		if (!isInside) continue;
		if (best === null || root.length > best.length) best = root;
	}
	return best;
}

export function toWorkspaceRelativePath(
	workspaceRoot: string,
	absoluteFilePath: string,
): string {
	return path
		.relative(workspaceRoot, absoluteFilePath)
		.split(path.sep)
		.join("/");
}

/** Bounded (R40) same-process record of each watched path's most recent in-app write hash, for self-write echo suppression (R18). */
export interface SelfWriteEchoTracker {
	record(absolutePath: string, hash: string): void;
	matches(absolutePath: string, hash: string): boolean;
}

const DEFAULT_MAX_TRACKED_PATHS = 16;

export function createSelfWriteEchoTracker(
	maxTrackedPaths = DEFAULT_MAX_TRACKED_PATHS,
): SelfWriteEchoTracker {
	const hashByPath = new Map<string, string>();
	return {
		record(absolutePath, hash) {
			hashByPath.delete(absolutePath);
			hashByPath.set(absolutePath, hash);
			while (hashByPath.size > maxTrackedPaths) {
				const oldest = hashByPath.keys().next();
				if (oldest.done) break;
				hashByPath.delete(oldest.value);
			}
		},
		matches(absolutePath, hash) {
			return hashByPath.get(absolutePath) === hash;
		},
	};
}

function logHistoryFailure(context: string, error: unknown) {
	console.error(
		`[doc-history] ${context} failed (real write/rename was not affected):`,
		error,
	);
}

export interface RecordInAppWriteParams {
	absoluteFilePath: string;
	content: string;
	grantedRoots: Iterable<string>;
	actorId: string;
	historyCause: InAppHistoryCause;
	echoTracker: SelfWriteEchoTracker;
}

/**
 * Records a history revision for an in-app save (R14) and echoes the
 * resulting content hash so the external-write watcher can recognize and
 * skip this same write (R18). Never throws (R29).
 */
export async function recordInAppWriteHistory(
	params: RecordInAppWriteParams,
): Promise<void> {
	try {
		if (!isVersionableMarkdownPath(params.absoluteFilePath)) return;
		const workspaceRoot = resolveHistoryWorkspaceRoot(
			params.absoluteFilePath,
			params.grantedRoots,
		);
		if (!workspaceRoot) return;

		const bytes = new TextEncoder().encode(params.content);
		const hash = await contentHash(bytes);
		params.echoTracker.record(params.absoluteFilePath, hash);

		const relativePath = toWorkspaceRelativePath(
			workspaceRoot,
			params.absoluteFilePath,
		);
		const by: RevisionAuthor = { kind: "human", id: params.actorId };
		await getHistoryStoreForWorkspace(workspaceRoot).recordRevision(
			relativePath,
			params.content,
			{
				by,
				cause: params.historyCause,
			},
		);
	} catch (error) {
		logHistoryFailure("recordInAppWriteHistory", error);
	}
}

export interface RecordExternalWriteParams {
	absoluteFilePath: string;
	grantedRoots: Iterable<string>;
	echoTracker: SelfWriteEchoTracker;
	/** Injected for tests; defaults to reading the real file. */
	readFile?: (absoluteFilePath: string) => Promise<Uint8Array>;
}

/**
 * Records a history revision for an external edit to the active file (R13).
 * Tolerates the transient `unlink` chokidar fires mid-atomic-replace (R35):
 * if the file can't be read right now (temporarily gone), this silently
 * no-ops rather than recording a bogus revision — the immediately-following
 * `add` event calls this again with the real final content. Never throws.
 */
export async function recordExternalWriteHistory(
	params: RecordExternalWriteParams,
): Promise<void> {
	try {
		if (!isVersionableMarkdownPath(params.absoluteFilePath)) return;
		const workspaceRoot = resolveHistoryWorkspaceRoot(
			params.absoluteFilePath,
			params.grantedRoots,
		);
		if (!workspaceRoot) return;

		const read =
			params.readFile ??
			(async (p: string) => new Uint8Array(await fs.readFile(p)));
		let bytes: Uint8Array;
		try {
			bytes = await read(params.absoluteFilePath);
		} catch {
			return; // file momentarily missing (unlink half of an atomic replace, or a real delete) — nothing to record
		}

		const hash = await contentHash(bytes);
		if (params.echoTracker.matches(params.absoluteFilePath, hash)) return; // our own just-written content (R18)

		const relativePath = toWorkspaceRelativePath(
			workspaceRoot,
			params.absoluteFilePath,
		);
		const content = new TextDecoder().decode(bytes);
		const by: RevisionAuthor = { kind: "external", id: "external-tool" };
		await getHistoryStoreForWorkspace(workspaceRoot).recordRevision(
			relativePath,
			content,
			{
				by,
				cause: "external-write",
			},
		);
	} catch (error) {
		logHistoryFailure("recordExternalWriteHistory", error);
	}
}

export interface RecordRenameParams {
	fromAbsolutePath: string;
	toAbsolutePath: string;
	grantedRoots: Iterable<string>;
}

/** Updates the path↔id index on a rename (R11, R31). Never throws. */
export async function recordRenameHistory(
	params: RecordRenameParams,
): Promise<void> {
	try {
		if (!isVersionableMarkdownPath(params.fromAbsolutePath)) return;
		const workspaceRoot = resolveHistoryWorkspaceRoot(
			params.fromAbsolutePath,
			params.grantedRoots,
		);
		if (!workspaceRoot) return;

		const fromRelative = toWorkspaceRelativePath(
			workspaceRoot,
			params.fromAbsolutePath,
		);
		const toRelative = toWorkspaceRelativePath(
			workspaceRoot,
			params.toAbsolutePath,
		);
		await getHistoryStoreForWorkspace(workspaceRoot).renamePath(
			fromRelative,
			toRelative,
		);
	} catch (error) {
		logHistoryFailure("recordRenameHistory", error);
	}
}

export interface RecordDeleteParams {
	absoluteFilePath: string;
	grantedRoots: Iterable<string>;
}

/**
 * Breaks the deleted path's binding to its document id (R33) so a later,
 * unrelated document written to the same path mints a fresh id instead of
 * silently continuing the deleted document's revision log. Never throws —
 * mirrors the "never affects the real operation" contract every other hook
 * in this file follows; the caller runs the real `fs.rm` first regardless of
 * what happens here.
 */
export async function recordDeleteHistory(
	params: RecordDeleteParams,
): Promise<void> {
	try {
		if (!isVersionableMarkdownPath(params.absoluteFilePath)) return;
		const workspaceRoot = resolveHistoryWorkspaceRoot(
			params.absoluteFilePath,
			params.grantedRoots,
		);
		if (!workspaceRoot) return;

		const relativePath = toWorkspaceRelativePath(
			workspaceRoot,
			params.absoluteFilePath,
		);
		await getHistoryStoreForWorkspace(workspaceRoot).forgetDocumentAtPath(
			relativePath,
		);
	} catch (error) {
		logHistoryFailure("recordDeleteHistory", error);
	}
}

const ACTOR_IDENTITY_FILE_NAME = "actor-id.json";

/**
 * Loads (or mints once) a small local device/user id, persisted next to the
 * existing `grants.json` file, used as `by.id` on human/external revisions.
 */
export async function loadOrCreateActorId(
	userDataDir: string,
): Promise<string> {
	const filePath = path.join(userDataDir, ACTOR_IDENTITY_FILE_NAME);
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as { id?: unknown };
		if (typeof parsed.id === "string" && parsed.id.length > 0) return parsed.id;
	} catch {
		// Missing or malformed actor id file — mint a fresh one below.
	}
	const id = crypto.randomUUID();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify({ id }, null, 2));
	return id;
}
