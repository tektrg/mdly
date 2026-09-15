import { registerDeviceSlot } from "@mdly/cloudflare-client";
import {
	type AnyCommentEvent,
	type CommentAuthor,
	readCommentEvents,
} from "@mdly/doc-comments";
import { generateId } from "@mdly/doc-history";
import type { TextAnchor } from "@mdly/workspace-kit";
import { ensureDeviceId } from "../connection/deviceId";
import { WORKER_BASE_URL } from "../connection/workerUrl";
import {
	computeStringHash,
	getActionCtx,
	readConflictRemote,
	refreshFiles,
} from "../store/actions";
import { workspaceStore } from "../store/state";
import { deviceLabelFor } from "./deviceLabel";
import { createRemoteFileSystem } from "./remoteFileSystem";

const SLOT_CACHE_KEY = "hubble.deviceSlot";

/** The browser's comment identity — mirrors useCommentOptions' author. */
export function webAuthor(): CommentAuthor {
	return {
		kind: "human",
		id: ensureDeviceId(),
		label: deviceLabelFor(navigator.userAgent),
	};
}

function readSlotCache(): Record<string, number> {
	try {
		const raw = localStorage.getItem(SLOT_CACHE_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : {};
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, number>;
		}
	} catch {
		// Corrupt cache — re-register below.
	}
	return {};
}

/**
 * The workspace's comment-log slot for this browser (server Step 8).
 * Registered once per (workspace, device) then cached in localStorage.
 * Idempotent server-side: re-registering returns the existing slot.
 */
export async function ensureDeviceSlot(): Promise<number> {
	const ctx = getActionCtx();
	if (!ctx) throw new Error("actions not initialized");
	const cached = readSlotCache()[ctx.workspaceId];
	if (typeof cached === "number") return cached;
	const slot = await registerDeviceSlot({
		baseUrl: WORKER_BASE_URL,
		auth: { kind: "cookie" },
		workspaceId: ctx.workspaceId,
		deviceId: ctx.deviceId,
		label: deviceLabelFor(navigator.userAgent),
	});
	try {
		localStorage.setItem(
			SLOT_CACHE_KEY,
			JSON.stringify({ ...readSlotCache(), [ctx.workspaceId]: slot }),
		);
	} catch {
		// Private-mode quota etc. — worst case we re-register next time
		// (idempotent, same slot back).
	}
	return slot;
}

/**
 * Slot-suffixed comment log path. The server's slot invariant enforces that
 * a registered browser writes ONLY its own suffixed log — never the Mac's
 * unsuffixed canonical log (which it would rightly reject).
 */
export function slotLogPath(docId: string, slot: number): string {
	return `.mdly/comments/${docId} (${slot}).jsonl`;
}

/**
 * Head-event id of a thread: the event no other event references as `prev`,
 * greatest id wins. Mirrors `findHead` in
 * `packages/doc-comments/src/commentStore.ts` (kept local because that
 * helper isn't exported — and it must stay in sync with it). Ids are
 * time-ordered, so "greatest" is "latest".
 */
export function threadHeadId(
	events: AnyCommentEvent[],
	threadId: string,
): string | null {
	const threadEvents = events.filter((e) => e.threadId === threadId);
	if (threadEvents.length === 0) return null;
	const referenced = new Set(
		threadEvents.map((e) => e.prev).filter((prev) => prev !== null),
	);
	const heads = threadEvents.filter((e) => !referenced.has(e.id));
	let winner: string | null = null;
	for (const head of heads) {
		if (winner === null || head.id > winner) winner = head.id;
	}
	return winner;
}
async function appendToSlotLog(
	docId: string,
	event: AnyCommentEvent,
): Promise<void> {
	const ctx = getActionCtx();
	if (!ctx) throw new Error("actions not initialized");
	const slot = await ensureDeviceSlot();
	const logPath = slotLogPath(docId, slot);
	// Guarded read-modify-write with one retry: two tabs sharing this
	// browser's device+slot appending at once would otherwise drop one event
	// (tail overwrite). The guard is the slot log's last-seen hash — "" for
	// a brand-new log (create-guard). A second consecutive 409 means genuine
	// contention; it propagates to the composer's inline error slot.
	for (let attempt = 0; attempt < 2; attempt++) {
		const existing = workspaceStore.get().sidecars[logPath];
		const base = existing?.content ?? "";
		const line = JSON.stringify(event);
		const next =
			base.length > 0 && !base.endsWith("\n")
				? `${base}\n${line}\n`
				: `${base}${line}\n`;
		try {
			await ctx.backend.pushFile({
				workspaceId: ctx.workspaceId,
				path: logPath,
				contentHash: await computeStringHash(next),
				content: next,
				deviceId: ctx.deviceId,
				expectedContentHash: existing?.contentHash ?? "",
			});
			break;
		} catch (err) {
			if (readConflictRemote(err) && attempt === 0) {
				// Re-read the winner's tail, then re-append below.
				await refreshFiles();
				continue;
			}
			throw err;
		}
	}
	// Re-list: the sidecar map updates and commentsVersion bumps when the
	// content moved, repainting every thread surface (our own broadcast echo
	// is ledger-suppressed, so nobody else does this for us).
	await refreshFiles();
}

async function readAllEvents(docId: string): Promise<AnyCommentEvent[]> {
	return readCommentEvents(
		createRemoteFileSystem(workspaceStore.get().sidecars),
		"",
		docId,
	);
}

export async function openCommentThread(
	docId: string,
	anchor: TextAnchor,
	text: string,
): Promise<void> {
	const id = generateId();
	await appendToSlotLog(docId, {
		id,
		threadId: id,
		kind: "thread-opened",
		prev: null,
		by: webAuthor(),
		anchor,
		text,
	});
}

export async function replyToCommentThread(
	docId: string,
	threadId: string,
	text: string,
): Promise<void> {
	const head = threadHeadId(await readAllEvents(docId), threadId);
	await appendToSlotLog(docId, {
		id: generateId(),
		threadId,
		kind: "replied",
		prev: head,
		by: webAuthor(),
		text,
	});
}

export async function resolveCommentThread(
	docId: string,
	threadId: string,
): Promise<void> {
	const head = threadHeadId(await readAllEvents(docId), threadId);
	await appendToSlotLog(docId, {
		id: generateId(),
		threadId,
		kind: "resolved",
		prev: head,
		by: webAuthor(),
	});
}

export async function reopenCommentThread(
	docId: string,
	threadId: string,
): Promise<void> {
	const head = threadHeadId(await readAllEvents(docId), threadId);
	await appendToSlotLog(docId, {
		id: generateId(),
		threadId,
		kind: "reopened",
		prev: head,
		by: webAuthor(),
	});
}

export async function deleteCommentThread(
	docId: string,
	threadId: string,
): Promise<void> {
	const head = threadHeadId(await readAllEvents(docId), threadId);
	await appendToSlotLog(docId, {
		id: generateId(),
		threadId,
		kind: "deleted",
		prev: head,
		by: webAuthor(),
	});
}
