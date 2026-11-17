/**
 * Tails a document's event file by byte offset (polling — `fs.watch` is
 * unreliable on network/synced folders). Only complete lines are emitted; a
 * half-written tail waits for its newline.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { HookEvent, HookOrigin } from "./events.js";
import { eventsPath, parseHookLines } from "./events.js";

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

async function fileSize(file: string): Promise<number> {
	try {
		return (await fs.stat(file)).size;
	} catch {
		return 0;
	}
}

export async function watchHookEvents(options: WatchOptions): Promise<void> {
	const file = eventsPath(options.workspaceRoot, options.doc);
	const skip = new Set(options.skipOrigins ?? ["agent"]);
	let offset = options.fromStart ? 0 : await fileSize(file);
	const interval = options.intervalMs ?? 400;

	const poll = async () => {
		const size = await fileSize(file);
		if (size < offset) offset = 0; // truncated/replaced: start over
		if (size === offset) return;
		const handle = await fs.open(file, "r");
		try {
			const buffer = Buffer.alloc(size - offset);
			await handle.read(buffer, 0, buffer.length, offset);
			const text = buffer.toString("utf8");
			const lastNewline = text.lastIndexOf("\n");
			if (lastNewline < 0) return;
			offset += Buffer.byteLength(text.slice(0, lastNewline + 1));
			for (const event of parseHookLines(text.slice(0, lastNewline + 1))) {
				if (!skip.has(event.origin)) options.onEvent(event);
			}
		} finally {
			await handle.close();
		}
	};

	while (!options.signal.aborted) {
		await poll();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, interval);
			options.signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});
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
