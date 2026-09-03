import { authHeaders, type CloudflareAuth } from "./auth.js";
import { CloudflareClientError } from "./errors.js";
import { buildUrl, requestJson } from "./httpClient.js";
import { GetFilesResponseSchema, VersionMessageSchema } from "./schemas.js";

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

const RECONNECT_DELAY_MS = 1000;

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
		if (!this.socket) return;
		this.socket.removeEventListener("open", this.handleOpen);
		this.socket.removeEventListener("message", this.handleMessage);
		this.socket.removeEventListener("close", this.handleClose);
		this.socket.removeEventListener("error", this.handleError);
		try {
			this.socket.close();
		} catch {
			// already closed/closing
		}
		this.socket = null;
	}

	private connect(): void {
		if (this.disposed) return;
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
	}

	private handleOpen = (): void => {
		this.lastMessageAt = Date.now();
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
		this.notifyAll();
	};

	private handleClose = (): void => {
		this.teardownSocket();
		if (!this.disposed) this.scheduleReconnect();
	};

	private handleError = (): void => {
		this.notifyError(new CloudflareClientError("Cloud sync connection error"));
	};

	private scheduleReconnect(): void {
		if (this.disposed || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, RECONNECT_DELAY_MS);
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		const interval = this.options.heartbeatIntervalMs ?? 15000;
		this.heartbeatTimer = setInterval(() => {
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
		try {
			await requestJson(
				buildUrl(this.options.baseUrl, "/api/files", {
					workspaceId: this.workspaceId,
					since: String(this.lastKnownVersion),
				}),
				{ headers: authHeaders(this.options.auth) },
				GetFilesResponseSchema,
				"getFiles(reconnect resync)",
			);
		} catch (err) {
			this.notifyError(
				err instanceof Error ? err : new CloudflareClientError(String(err)),
			);
		}
		this.notifyAll();
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
