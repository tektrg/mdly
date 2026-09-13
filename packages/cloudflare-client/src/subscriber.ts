import { authHeaders, type CloudflareAuth } from "./auth.js";
import { CloudflareClientError } from "./errors.js";
import { buildUrl, requestJson } from "./httpClient.js";
import { VersionMessageSchema, VersionResponseSchema } from "./schemas.js";
import type { VersionLedger } from "./versionLedger.js";

/** Same shape as the old `@hubble.md/convex-client`'s `Subscriber` (R9) — callers (apps/www's AppShell, the CLI's `cloud watch`) don't change at all. */
export type Subscriber = {
	onFilesChanged(
		workspaceId: string,
		callback: () => void,
		onError: (err: Error) => void,
	): () => void;
	onAssetsChanged(
		workspaceId: string,
		callback: () => void,
		onError: (err: Error) => void,
	): () => void;
	close(): Promise<void>;
};

/**
 * The subset of the WHATWG `WebSocket` API this client needs. Both the
 * global `WebSocket` (browsers, and Node 22+) and the `ws` package's
 * `WebSocket` class satisfy this — see `webSocketFactory` below.
 */
export type WebSocketLike = {
	addEventListener(
		type: "open" | "message" | "close" | "error",
		// biome-ignore lint/suspicious/noExplicitAny: one signature covers open/close/error events (no `.data`) and message events (which do), across two different runtime event types (DOM's and `ws`'s) — narrowing it would make every caller cast anyway, so the cast lives here once instead.
		listener: (event: any) => void,
	): void;
	removeEventListener(
		type: "open" | "message" | "close" | "error",
		// biome-ignore lint/suspicious/noExplicitAny: matches addEventListener above.
		listener: (event: any) => void,
	): void;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	readonly readyState: number;
};

export type WebSocketFactory = (
	url: string,
	opts: { headers?: Record<string, string> },
) => WebSocketLike;

export type CreateCloudflareSubscriberOptions = {
	baseUrl: string;
	auth: CloudflareAuth;
	/** How often the client pings to detect a silently-dead connection (R42). Defaults to 15s. */
	heartbeatIntervalMs?: number;
	/**
	 * Overrides how a WebSocket connection is opened. Defaults to the global
	 * `WebSocket` (works for `auth.kind === "cookie"`: browsers attach the
	 * session cookie to the handshake automatically). `auth.kind === "bearer"`
	 * needs a custom `Authorization` header on the handshake, which the
	 * standard WebSocket API cannot set — pass a factory built on the `ws`
	 * package instead (see `@mdly/cloudflare-client/node-ws`), which the CLI
	 * and desktop app do.
	 */
	webSocketFactory?: WebSocketFactory;
	/**
	 * Shared self-echo ledger (DO row-read frequency fix, 2b): the SAME
	 * object the backend was constructed with. An incoming version that is
	 * an exact member of this ledger is this client's own echo — recorded
	 * but never notified. Exact membership only, never `<=` (a `<=` rule
	 * would swallow another device's lower-numbered change: data loss).
	 */
	versionLedger?: VersionLedger;
};

function toWebSocketUrl(baseUrl: string, path: string): string {
	const url = new URL(path, baseUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

function defaultWebSocketFactory(url: string): WebSocketLike {
	if (typeof WebSocket === "undefined") {
		throw new CloudflareClientError(
			"No global WebSocket is available in this runtime. Pass a webSocketFactory " +
				"(see @mdly/cloudflare-client/node-ws for bearer-token/Node usage).",
		);
	}
	return new WebSocket(url) as unknown as WebSocketLike;
}

type Listener = { callback: () => void; onError: (err: Error) => void };

/**
 * Reconnect backoff. A FIXED 1s retry used to be the whole policy, which
 * turns a persistently failing server into a self-inflicted amplifier: when
 * the Durable Object cannot even be constructed (free-tier row-read quota
 * exhausted, for instance), every client re-attempted once per second
 * forever, and every attempt cost more reads — pinning the workspace at zero
 * quota and re-exhausting the next allowance the moment it reset.
 *
 * Exponential backoff with jitter caps that at one attempt per minute (a 60x
 * reduction while an outage lasts) while keeping the first retry fast, so an
 * ordinary network blip still recovers in about a second. Jitter keeps many
 * clients from retrying in lockstep.
 */
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 60000;
const RECONNECT_JITTER_RATIO = 0.2;

export function reconnectDelayMs(
	attempt: number,
	random: () => number = Math.random,
): number {
	// The FIRST retry is exact and un-jittered: a single client recovering
	// from an ordinary blip should do so predictably, and jitter only earns
	// its keep once many clients are stuck retrying together.
	if (attempt <= 0) return RECONNECT_BASE_DELAY_MS;
	// attempt 1 -> ~2s, 2 -> ~4s, 3 -> ~8s ... capped at ~60s.
	const exponential = Math.min(
		RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, attempt),
		RECONNECT_MAX_DELAY_MS,
	);
	// +/- 20%, never below the base delay and never above the cap.
	const jitter = exponential * RECONNECT_JITTER_RATIO * (random() * 2 - 1);
	return Math.min(
		RECONNECT_MAX_DELAY_MS,
		Math.max(RECONNECT_BASE_DELAY_MS, Math.round(exponential + jitter)),
	);
}

/**
 * Error sink kept on a socket across `teardownSocket()`'s `close()` — see
 * that method for why removing every listener first turns a handshake abort
 * into a process-killing unhandled 'error'.
 */
function noopSocketErrorSink(): void {}

/** `WebSocket.OPEN` — spelled out because `WebSocketLike` carries only the numeric `readyState`, not the named constants. */
const WEBSOCKET_OPEN = 1;

/**
 * Upper bound for one handshake to complete. The heartbeat's staleness check
 * deliberately skips still-connecting sockets (judging them against a
 * pre-connect timestamp aborted every slow handshake), so without this a
 * hung handshake would never be retried. Fires teardown + reconnect, like
 * the staleness branch. Well above any healthy handshake; well below the
 * ~45 s a hung handshake used to survive by accident (three ticks at the
 * 15 s default interval: stale only past 2 × interval on the third).
 */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * One logical subscription to a single workspace's broadcast socket, shared
 * between however many `onFilesChanged`/`onAssetsChanged` callers are
 * currently registered for it (R25 — exactly one live connection per
 * workspace no matter how many listeners or how many times it has flapped).
 */
class WorkspaceConnection {
	private socket: WebSocketLike | null = null;
	private lastKnownVersion = 0;
	private hasConnectedBefore = false;
	private disposed = false;
	private lastMessageAt = Date.now();
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	/** Bounds one handshake; cleared once the socket opens or dies (see `connect()`). */
	private connectTimer: ReturnType<typeof setTimeout> | null = null;
	/** Consecutive failed connection attempts; reset once a socket opens. */
	private reconnectAttempts = 0;
	private readonly fileListeners = new Set<Listener>();
	private readonly assetListeners = new Set<Listener>();

	constructor(
		private readonly workspaceId: string,
		private readonly options: CreateCloudflareSubscriberOptions,
	) {
		// Deferred to a microtask: `connectionFor()` constructs this instance
		// and then immediately calls `.subscribe()` on it in the same
		// synchronous block. Connecting eagerly here would let a synchronous
		// failure (e.g. bearer auth with no webSocketFactory) call
		// `notifyError()` before any listener has been registered, dropping
		// the error into an empty set with no one left to hear it.
		queueMicrotask(() => this.connect());
	}

	subscribe(
		kind: "files" | "assets",
		callback: () => void,
		onError: (err: Error) => void,
	): () => void {
		const listener: Listener = { callback, onError };
		const set = kind === "files" ? this.fileListeners : this.assetListeners;
		set.add(listener);
		return () => {
			set.delete(listener);
			if (this.fileListeners.size === 0 && this.assetListeners.size === 0) {
				this.dispose();
			}
		};
	}

	get isIdle(): boolean {
		return this.fileListeners.size === 0 && this.assetListeners.size === 0;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopHeartbeat();
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.teardownSocket();
	}

	private notifyAll(): void {
		for (const listener of this.fileListeners)
			this.safeInvoke(listener.callback);
		for (const listener of this.assetListeners)
			this.safeInvoke(listener.callback);
	}

	private notifyError(err: Error): void {
		for (const listener of [...this.fileListeners, ...this.assetListeners]) {
			try {
				listener.onError(err);
			} catch {
				// A listener's own error handler throwing is not this connection's problem.
			}
		}
	}

	private safeInvoke(callback: () => void): void {
		try {
			callback();
		} catch {
			// A listener's own callback throwing must never take down the connection.
		}
	}

	private teardownSocket(): void {
		const socket = this.socket;
		if (!socket) return;
		this.socket = null;
		socket.removeEventListener("open", this.handleOpen);
		socket.removeEventListener("message", this.handleMessage);
		socket.removeEventListener("close", this.handleClose);
		socket.removeEventListener("error", this.handleError);
		// `ws` reports aborting a still-connecting handshake ASYNCHRONOUSLY
		// (`abortHandshake` defers `emitErrorAndClose` to the next tick), so
		// removing the `error` listener before `close()` leaves that emit
		// unhandled — and Node throws an unhandled 'error' event, which kills
		// the Electron main process with a modal dialog. The try/catch around
		// `close()` below cannot help: it only covers synchronous throws.
		// Keep a no-op sink attached for the socket's remaining life instead.
		// (Only 'error' needs this; unlistened 'close'/'message'/'open'
		// emits are harmless.) `dispose()` routes through here, so process
		// exit and `subscriber.close()` are covered by the same change.
		socket.addEventListener("error", noopSocketErrorSink);
		try {
			socket.close();
		} catch {
			// already closed/closing (synchronous failures)
		}
		this.clearConnectTimeout();
	}

	private connect(): void {
		if (this.disposed) return;
		// Each fresh socket gets a fresh grace window: without this, a
		// reconnect following an idle gap inherits the pre-drop timestamp
		// and the first heartbeat tick already reads as stale.
		this.lastMessageAt = Date.now();
		if (this.options.auth.kind === "bearer" && !this.options.webSocketFactory) {
			this.notifyError(
				new CloudflareClientError(
					"bearer-token auth requires an explicit webSocketFactory — see @mdly/cloudflare-client/node-ws",
				),
			);
			return;
		}
		const factory = this.options.webSocketFactory ?? defaultWebSocketFactory;
		const url = toWebSocketUrl(
			this.options.baseUrl,
			`/api/workspace/${encodeURIComponent(this.workspaceId)}/socket`,
		);
		let socket: WebSocketLike;
		try {
			socket = factory(url, { headers: authHeaders(this.options.auth) });
		} catch (err) {
			this.notifyError(
				err instanceof Error ? err : new CloudflareClientError(String(err)),
			);
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		socket.addEventListener("open", this.handleOpen);
		socket.addEventListener("message", this.handleMessage);
		socket.addEventListener("close", this.handleClose);
		socket.addEventListener("error", this.handleError);
		this.startHeartbeat();
		this.startConnectTimeout();
	}

	private startConnectTimeout(): void {
		this.clearConnectTimeout();
		this.connectTimer = setTimeout(() => {
			this.connectTimer = null;
			if (this.disposed) return;
			// The handshake never completed — tear down and retry rather
			// than hanging forever. (Safe to close a CONNECTING socket here
			// only because F1's error sink absorbs the handshake-abort emit.)
			this.teardownSocket();
			this.scheduleReconnect();
		}, CONNECT_TIMEOUT_MS);
	}

	private clearConnectTimeout(): void {
		if (this.connectTimer) clearTimeout(this.connectTimer);
		this.connectTimer = null;
	}

	private handleOpen = (): void => {
		this.clearConnectTimeout();
		this.lastMessageAt = Date.now();
		// A real open clears the backoff: the next blip retries fast again.
		this.reconnectAttempts = 0;
		const isReconnect = this.hasConnectedBefore;
		this.hasConnectedBefore = true;
		// R42's client half: on reconnect, automatically resync from the last
		// known version — never wait for a caller-invoked manual reload.
		if (isReconnect) void this.resyncAfterReconnect();
	};

	private handleMessage = (event: { data: unknown }): void => {
		this.lastMessageAt = Date.now();
		let parsed: unknown;
		try {
			parsed = JSON.parse(String(event.data));
		} catch {
			return; // not JSON — ignore rather than crash the connection
		}
		const result = VersionMessageSchema.safeParse(parsed);
		if (!result.success) return; // unrecognized message shape — ignore, don't throw
		this.lastKnownVersion = Math.max(
			this.lastKnownVersion,
			result.data.version,
		);
		// Self-echo suppression (2b): this client produced this version (the
		// backend recorded it in the shared ledger when the mutation
		// response arrived), so there is nothing to re-read. The version is
		// still tracked above — only the notification is skipped.
		if (this.options.versionLedger?.has(result.data.version)) return;
		this.notifyAll();
	};

	private handleClose = (): void => {
		this.clearConnectTimeout();
		this.teardownSocket();
		if (!this.disposed) this.scheduleReconnect();
	};

	private handleError = (): void => {
		this.notifyError(new CloudflareClientError("Cloud sync connection error"));
	};

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer) return;
		const delay = reconnectDelayMs(this.reconnectAttempts);
		this.reconnectAttempts += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		const interval = this.options.heartbeatIntervalMs ?? 15000;
		this.heartbeatTimer = setInterval(() => {
			const socket = this.socket;
			// A still-connecting socket is judged by the connect timeout,
			// not here: without this guard, a fresh socket after an idle
			// gap inherits a stale timestamp and is torn down ~15 s in even
			// when its handshake would have succeeded — a self-inflicted
			// reconnect loop.
			if (!socket || socket.readyState !== WEBSOCKET_OPEN) return;
			const staleFor = Date.now() - this.lastMessageAt;
			if (staleFor > interval * 2) {
				// No message (not even our own ping's echo) for two full
				// intervals — treat this as a silently-dead connection (R42)
				// and force a reconnect rather than waiting for a close event
				// that may never arrive.
				this.teardownSocket();
				this.scheduleReconnect();
				return;
			}
			try {
				this.socket?.send("ping");
			} catch {
				// A failed send will also trigger close/error on its own.
			}
		}, interval);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
	}

	private async resyncAfterReconnect(): Promise<void> {
		// Cheap 1-row version check (2d), NOT a full listing: the old shape
		// fetched the entire file list here and then discarded the response,
		// calling notifyAll() anyway — every reconnect re-read every row for
		// nothing. Listeners re-list on notify; the version comparison below
		// (plus each call site's own getVersion pre-check) is what decides
		// whether that listing actually happens.
		let current = this.lastKnownVersion;
		try {
			const data = await requestJson(
				buildUrl(this.options.baseUrl, "/api/version", {
					workspaceId: this.workspaceId,
				}),
				{ headers: authHeaders(this.options.auth) },
				VersionResponseSchema,
				"getVersion(reconnect resync)",
			);
			current = Math.max(current, data.version);
		} catch (err) {
			this.notifyError(
				err instanceof Error ? err : new CloudflareClientError(String(err)),
			);
		}
		const moved = current > this.lastKnownVersion;
		this.lastKnownVersion = current;
		// Nothing changed while we were gone — no reason to make every
		// listener re-list (this also absorbs the server's ping-echo, which
		// otherwise re-triggers a full resync on every heartbeat).
		if (moved) this.notifyAll();
	}
}

/**
 * Talks to the Worker's hibernating-WebSocket broadcast (R2, R42). Every
 * mutation bumps one per-workspace version counter and broadcasts it to
 * every open socket — the Worker doesn't distinguish "a file changed" from
 * "an asset changed" at the wire level, so (matching the old Convex-era
 * behavior of firing on every relevant update) both `onFilesChanged` and
 * `onAssetsChanged` callbacks fire on every broadcast; callers refetch
 * whichever list they care about.
 */
export function createCloudflareSubscriber(
	options: CreateCloudflareSubscriberOptions,
): Subscriber {
	const connections = new Map<string, WorkspaceConnection>();

	function connectionFor(workspaceId: string): WorkspaceConnection {
		let connection = connections.get(workspaceId);
		if (!connection) {
			connection = new WorkspaceConnection(workspaceId, options);
			connections.set(workspaceId, connection);
		}
		return connection;
	}

	function subscribe(
		kind: "files" | "assets",
		workspaceId: string,
		callback: () => void,
		onError: (err: Error) => void,
	): () => void {
		const connection = connectionFor(workspaceId);
		const unsubscribe = connection.subscribe(kind, callback, onError);
		return () => {
			unsubscribe();
			if (connection.isIdle) connections.delete(workspaceId);
		};
	}

	return {
		onFilesChanged: (workspaceId, callback, onError) =>
			subscribe("files", workspaceId, callback, onError),
		onAssetsChanged: (workspaceId, callback, onError) =>
			subscribe("assets", workspaceId, callback, onError),
		async close() {
			for (const connection of connections.values()) connection.dispose();
			connections.clear();
		},
	};
}
