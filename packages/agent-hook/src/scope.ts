/**
 * Watch scope: what a subscriber listens to.
 * - `file`: one doc, in a workspace or standalone (opened outside any workspace);
 * - `workspace`: every doc whose stream lives in that workspace;
 * - `open`: whatever mdly has open right now, following opens and closes.
 *
 * Where a doc's stream lives is decided by ONE rule, shared by the app and the
 * CLI (`resolveDocStore`): the nearest folder holding `.mdly`, else a
 * standalone store in the app's data folder (so watching a loose file never
 * drops a `.mdly` folder next to it).
 */
import { existsSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { HookEvent, HookOrigin } from "./events.js";
import { eventsPath, hookDir, rotatedEventsPath } from "./events.js";
import { defaultIsPidAlive, type Subscriber } from "./subscribers.js";
import { abortableSleep, EventFileTailer } from "./watch.js";

export type WatchScope =
	| { kind: "file"; path: string }
	| { kind: "workspace"; root: string }
	| { kind: "open" };

export interface DocStore {
	/** Folder whose `.mdly/agent-hook` holds the stream. */
	workspaceRoot: string;
	/** Key of the doc in that store: workspace-relative, or absolute when standalone. */
	doc: string;
	/** Absolute path of the doc. */
	path: string;
}

export function standaloneStoreRoot(appDataDir: string): string {
	return path.join(appDataDir, "agent-hook", "standalone");
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Nearest ancestor folder holding `.mdly` (sync: used per request in the app). */
export function findWorkspaceRootSync(absoluteDocPath: string): string | null {
	let dir = path.dirname(absoluteDocPath);
	for (;;) {
		if (isDir(path.join(dir, ".mdly"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function resolveDocStore(
	absoluteDocPath: string,
	appDataDir: string,
): DocStore {
	const absolute = path.resolve(absoluteDocPath);
	const root = findWorkspaceRootSync(absolute);
	if (root) {
		return {
			workspaceRoot: root,
			doc: path.relative(root, absolute),
			path: absolute,
		};
	}
	return {
		workspaceRoot: standaloneStoreRoot(appDataDir),
		doc: absolute,
		path: absolute,
	};
}

/** Absolute path of an event's doc, given the store it was read from. */
export function eventDocPath(workspaceRoot: string, doc: string): string {
	return path.isAbsolute(doc) ? doc : path.join(workspaceRoot, doc);
}

function isInside(root: string, absolute: string): boolean {
	const relative = path.relative(root, absolute);
	return (
		relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
	);
}

export function subscriberCovers(
	sub: Pick<Subscriber, "scope">,
	absoluteDocPath: string,
	openDocs: readonly string[],
): boolean {
	const scope = sub.scope;
	if (scope.kind === "file") return scope.path === absoluteDocPath;
	if (scope.kind === "workspace") return isInside(scope.root, absoluteDocPath);
	return openDocs.includes(absoluteDocPath);
}

// --- Open docs ---------------------------------------------------------------

export function openDocsPath(appDataDir: string): string {
	return path.join(appDataDir, "agent-hook", "open-docs.json");
}

/** The app publishes what it has open; written atomically. */
export async function writeOpenDocs(
	appDataDir: string,
	paths: readonly string[],
	pid: number = process.pid,
): Promise<void> {
	const file = openDocsPath(appDataDir);
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(
		tmp,
		JSON.stringify({ pid, paths: [...new Set(paths)].sort() }),
	);
	await fs.rename(tmp, file);
}

/** What mdly has open; nothing when the app that wrote it is gone. */
export async function readOpenDocs(
	appDataDir: string,
	isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): Promise<string[]> {
	try {
		const raw = JSON.parse(
			await fs.readFile(openDocsPath(appDataDir), "utf8"),
		) as { pid?: unknown; paths?: unknown };
		if (typeof raw.pid !== "number" || !isPidAlive(raw.pid)) return [];
		return Array.isArray(raw.paths)
			? raw.paths.filter((p): p is string => typeof p === "string")
			: [];
	} catch {
		return [];
	}
}

// --- Watching a scope ----------------------------------------------------------

interface StreamTarget {
	file: string;
	rotated: string;
	workspaceRoot: string;
}

function targetFor(
	store: Pick<DocStore, "workspaceRoot" | "doc">,
): StreamTarget {
	return {
		file: eventsPath(store.workspaceRoot, store.doc),
		rotated: rotatedEventsPath(store.workspaceRoot, store.doc),
		workspaceRoot: store.workspaceRoot,
	};
}

async function scopeTargets(
	scope: WatchScope,
	appDataDir: string,
): Promise<StreamTarget[]> {
	if (scope.kind === "file")
		return [targetFor(resolveDocStore(scope.path, appDataDir))];
	if (scope.kind === "open")
		return (await readOpenDocs(appDataDir)).map((p) =>
			targetFor(resolveDocStore(p, appDataDir)),
		);
	// A subfolder of a workspace reads the enclosing workspace's streams
	// (filtered to its docs by `inScope`), never a store of its own.
	const storeRoot = workspaceStoreRoot(scope.root);
	const dir = hookDir(storeRoot);
	let names: string[] = [];
	try {
		names = await fs.readdir(dir);
	} catch {
		// no streams yet
	}
	return names
		.filter((n) => n.endsWith(".events.jsonl"))
		.map((n) => {
			const file = path.join(dir, n);
			return {
				file,
				rotated: file.replace(/\.events\.jsonl$/, ".events.1.jsonl"),
				workspaceRoot: storeRoot,
			};
		});
}

/** The folder whose `.mdly` holds the streams of docs in `root`. */
export function workspaceStoreRoot(root: string): string {
	const absolute = path.resolve(root);
	if (isDir(path.join(absolute, ".mdly"))) return absolute;
	return findWorkspaceRootSync(absolute) ?? absolute;
}

/** Workspace scope may be a subfolder of its store: only its own docs count. */
function inScope(scope: WatchScope, absoluteDocPath: string): boolean {
	return scope.kind !== "workspace" || isInside(scope.root, absoluteDocPath);
}

export interface ScopeWatchOptions {
	appDataDir: string;
	scope: WatchScope;
	fromStart?: boolean;
	/** Events from these origins are skipped (default: the agent's own). */
	skipOrigins?: HookOrigin[];
	intervalMs?: number;
	signal: AbortSignal;
	/** Each event with the absolute path of its doc. */
	onEvent: (event: HookEvent, absoluteDocPath: string) => void;
	/** Called once the starting positions are fixed: events after this are delivered. */
	onReady?: () => void;
}

/**
 * Tails every stream in scope. Streams joining later: a workspace's brand-new
 * stream is read from its start (it was created after we started); a doc
 * that opens later is followed from its current end (no stale replay).
 */
export async function watchScope(options: ScopeWatchOptions): Promise<void> {
	const skip = new Set(options.skipOrigins ?? ["agent"]);
	const interval = options.intervalMs ?? 400;
	const tailers = new Map<
		string,
		{ tailer: EventFileTailer; workspaceRoot: string }
	>();
	let first = true;
	while (!options.signal.aborted) {
		const targets = await scopeTargets(options.scope, options.appDataDir);
		const wanted = new Set(targets.map((t) => t.file));
		for (const file of tailers.keys())
			if (!wanted.has(file)) tailers.delete(file);
		for (const target of targets) {
			if (tailers.has(target.file)) continue;
			const tailer = new EventFileTailer(target.file, target.rotated);
			await tailer.start(
				first ? options.fromStart === true : options.scope.kind === "workspace",
			);
			tailers.set(target.file, { tailer, workspaceRoot: target.workspaceRoot });
		}
		if (first) options.onReady?.();
		first = false;
		for (const { tailer, workspaceRoot } of tailers.values()) {
			for (const event of await tailer.poll()) {
				if (skip.has(event.origin)) continue;
				const docPath = eventDocPath(workspaceRoot, event.doc);
				if (!inScope(options.scope, docPath)) continue;
				options.onEvent(event, docPath);
			}
		}
		await abortableSleep(interval, options.signal);
	}
}

export interface ScopedEvent {
	event: HookEvent;
	/** Absolute path of the event's doc. */
	path: string;
}

type Cursor = Record<string, { ino: number | null; offset: number }>;

function decodeCursor(cursor: string | undefined): Cursor | null {
	if (!cursor) return null;
	try {
		const parsed = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		);
		return parsed && typeof parsed === "object" ? (parsed as Cursor) : null;
	} catch {
		return null;
	}
}

/**
 * Stateless polling for request/response transports (the MCP `watch_events`
 * tool): the events in scope since `cursor`, plus the next cursor (byte
 * positions per stream, so nothing is missed or repeated). No cursor = start
 * from now. Same join rules as `watchScope`.
 */
export async function readScopeEvents(
	appDataDir: string,
	scope: WatchScope,
	cursor?: string,
	skipOrigins: HookOrigin[] = ["agent"],
): Promise<{ events: ScopedEvent[]; cursor: string }> {
	const previous = decodeCursor(cursor);
	const skip = new Set(skipOrigins);
	const next: Cursor = {};
	const events: ScopedEvent[] = [];
	for (const target of await scopeTargets(scope, appDataDir)) {
		const tailer = new EventFileTailer(target.file, target.rotated);
		const position = previous?.[target.file];
		if (position) tailer.setPosition(position);
		else await tailer.start(previous !== null && scope.kind === "workspace");
		if (previous) {
			for (const event of await tailer.poll()) {
				if (skip.has(event.origin)) continue;
				const docPath = eventDocPath(target.workspaceRoot, event.doc);
				if (!inScope(scope, docPath)) continue;
				events.push({ event, path: docPath });
			}
		}
		next[target.file] = tailer.getPosition();
	}
	events.sort((a, b) => a.event.at.localeCompare(b.event.at));
	return {
		events,
		cursor: Buffer.from(JSON.stringify(next)).toString("base64url"),
	};
}

/** Makes `root` a workspace (creates `.mdly`) so the app files its streams there. */
export async function ensureWorkspace(root: string): Promise<void> {
	// Inside a workspace already: a nested `.mdly` would split its docs' streams.
	if (findWorkspaceRootSync(path.join(path.resolve(root), "x"))) return;
	if (!existsSync(path.join(root, ".mdly")))
		await fs.mkdir(path.join(root, ".mdly"), { recursive: true });
}
