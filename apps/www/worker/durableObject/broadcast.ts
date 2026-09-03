/**
 * Hibernating WebSocket broadcast (R2).
 *
 * Deliberately reads connections from `ctx.getWebSockets()` on every call
 * instead of keeping an in-memory Set built at `fetch`/`webSocketMessage`
 * time. An in-memory collection would be empty the instant the DO is
 * evicted and later re-constructed to handle a wake-up event — exactly the
 * "hibernated, then woken by this same mutation" case R2 requires to keep
 * working. `getWebSockets()` is backed by the runtime's own accepted-socket
 * registry, which survives eviction; that's the entire reason the
 * Hibernatable WebSocket API (`ctx.acceptWebSocket`) exists.
 */

export type VersionBroadcastMessage = {
	type: "version";
	version: number;
};

export function broadcastVersion(
	ctx: DurableObjectState,
	version: number,
): void {
	const message: VersionBroadcastMessage = { type: "version", version };
	const payload = JSON.stringify(message);
	for (const socket of ctx.getWebSockets()) {
		try {
			socket.send(payload);
		} catch {
			// A socket that fails to send is already gone or errored; the
			// hibernation runtime cleans up dead sockets on its own via
			// webSocketError/webSocketClose. Nothing to do here per-socket.
		}
	}
}

export function acceptHibernatingWebSocket(
	ctx: DurableObjectState,
	pair: InstanceType<typeof WebSocketPair>,
): Response {
	const client = pair[0];
	const server = pair[1];
	ctx.acceptWebSocket(server);
	return new Response(null, { status: 101, webSocket: client });
}
