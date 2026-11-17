/**
 * Tails a document's event file by byte offset (polling — `fs.watch` is
 * unreliable on network/synced folders). Only complete lines are emitted; a
 * half-written tail waits for its newline.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { HookEvent, HookOrigin } from "./events.js";
import {
	eventsPath,
	parseHookLines,
	readCompleteLines,
	rotatedEventsPath,
} from "./events.js";

export interface WatchOptions {
	workspaceRoot: string;
	doc: string;
	/** Start at the end (default) or replay history from the start. */
	fromStart?: boolean;
	/** Events from these origins are skipped (default: the agent's own). */
	skipOrigins?: HookOrigin[];
	intervalMs?: number;
	signal: AbortSignal;
	onEvent: (event: HookEvent) => void;
}

async function statFile(
	file: string,
): Promise<{ ino: number; size: number } | null> {
	try {
		return await fs.stat(file);
	} catch {
		return null;
	}
}

/**
 * Tails one events file by (inode, byte offset). A compaction renames the
 * file to its rotated name and starts a new one: the watcher drains what is
 * left of the old inode from the rotated file, then follows the new file.
 * `carried` lines (pending proposals copied into the new file) are skipped.
 */
export class EventFileTailer {
	private ino: number | null = null;
	private offset = 0;
	constructor(
		private readonly file: string,
		private readonly rotatedFile: string,
	) {}

	/** Positions at the current end (or 0 when `fromStart`). */
	async start(fromStart: boolean): Promise<void> {
		const stat = await statFile(this.file);
		this.ino = stat?.ino ?? null;
		this.offset = fromStart || !stat ? 0 : stat.size;
	}

	async poll(): Promise<HookEvent[]> {
		const out: HookEvent[] = [];
		const stat = await statFile(this.file);
		if (!stat) return out;
		if (this.ino !== null && stat.ino !== this.ino) {
			const rotated = await statFile(this.rotatedFile);
			if (rotated && rotated.ino === this.ino && rotated.size > this.offset) {
				const { text } = await readCompleteLines(
					this.rotatedFile,
					this.offset,
					rotated.size,
				);
				out.push(...parseHookLines(text));
			}
			this.offset = 0;
		} else if (stat.size < this.offset) {
			this.offset = 0; // truncated/replaced: start over
		}
		this.ino = stat.ino;
		if (stat.size > this.offset) {
			const { text, consumed } = await readCompleteLines(
				this.file,
				this.offset,
				stat.size,
			);
			this.offset += consumed;
			out.push(...parseHookLines(text));
		}
		return out.filter((e) => e.carried !== true);
	}
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

export async function watchHookEvents(options: WatchOptions): Promise<void> {
	const tailer = new EventFileTailer(
		eventsPath(options.workspaceRoot, options.doc),
		rotatedEventsPath(options.workspaceRoot, options.doc),
	);
	const skip = new Set(options.skipOrigins ?? ["agent"]);
	await tailer.start(options.fromStart === true);
	const interval = options.intervalMs ?? 400;
	while (!options.signal.aborted) {
		for (const event of await tailer.poll()) {
			if (!skip.has(event.origin)) options.onEvent(event);
		}
		await abortableSleep(interval, options.signal);
	}
}

/** Nearest ancestor holding a `.mdly` folder — the workspace root for a doc path. */
export async function findWorkspaceRoot(
	absoluteDocPath: string,
): Promise<string | null> {
	let dir = path.dirname(absoluteDocPath);
	for (;;) {
		try {
			if ((await fs.stat(path.join(dir, ".mdly"))).isDirectory()) return dir;
		} catch {
			// keep walking
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
