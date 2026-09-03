import { WebSocket as NodeWebSocket } from "ws";
import type { WebSocketFactory, WebSocketLike } from "./subscriber.js";

/**
 * A `WebSocketFactory` (see subscriber.ts) built on the `ws` package —
 * needed because the standard WebSocket API cannot set custom headers on
 * the handshake, and bearer-token auth (the desktop app and the CLI, R3)
 * needs to send `Authorization: Bearer <token>` on that handshake. `ws` is
 * Node-only, so this lives in its own module/export path
 * (`@mdly/cloudflare-client/node-ws`) rather than the package's root entry —
 * apps/www (bundled for the browser, cookie-auth only) never imports this
 * file, so its bundler never has to resolve `ws`'s Node built-ins.
 */
export function createNodeWebSocketFactory(): WebSocketFactory {
	return (url, opts) =>
		new NodeWebSocket(url, {
			headers: opts.headers,
		}) as unknown as WebSocketLike;
}
