import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { WebSocket as NodeWebSocket } from "ws";
import { createCloudflareBackend } from "./backend.js";
import {
	createCloudflareSubscriber,
	type WebSocketFactory,
	type WebSocketLike,
} from "./subscriber.js";
import type { RealWorkerHandle } from "./testHarness/realWorker.js";
import { startRealWorker, TEST_PASSWORD } from "./testHarness/realWorker.js";

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (predicate()) return resolve();
			if (Date.now() - start > timeoutMs)
				return reject(new Error("waitFor timed out"));
			setTimeout(tick, 20);
		};
		tick();
	});
}

type SocketEventType = "open" | "message" | "close" | "error";
// biome-ignore lint/suspicious/noExplicitAny: mirrors WebSocketLike's own addEventListener/removeEventListener signature in subscriber.ts — one signature covers open/close/error (no `.data`) and message events (which do).
type SocketEventListener = (event: any) => void;

/**
 * A hand-rolled `WebSocketLike` for the heartbeat tests below (R42) — no
 * real socket, no real Worker. The heartbeat tests need `vi.useFakeTimers()`
 * for deterministic, instant control over "how much time has passed", which
 * doesn't mix with the real Miniflare Worker + real `ws` sockets the rest of
 * this file uses (those rely on real network I/O completing in real time).
 */
type FakeBroadcastSocket = {
	/** Handed to the subscriber via its `webSocketFactory`. */
	socket: WebSocketLike;
	/** Simulates the server accepting the connection and firing `open`. */
	open(): void;
	/** Simulates the server broadcasting a version bump (a real file/asset mutation). */
	pushVersion(version: number): void;
	/** Every payload the client sent down this socket (in production, only ever "ping" — see `startHeartbeat`). */
	readonly sent: string[];
	readonly closed: boolean;
};

/**
 * `echoPing` mirrors the real Worker's `webSocketMessage` handler
 * (apps/www/worker/durableObject/workspaceDurableObject.ts, ~line 70), which
 * echoes a `{type:"version"}` message back in reply to the client's own
 * "ping" — in production that echo is the ONLY thing that keeps a healthy
 * but otherwise-idle connection's `lastMessageAt` fresh. `echoPing: false`
 * simulates that echo being missing entirely, including a total silent
 * death (no close/error, just no more replies of any kind).
 */
function createFakeBroadcastSocket(opts: {
	echoPing: boolean;
}): FakeBroadcastSocket {
	const listeners: Record<SocketEventType, Set<SocketEventListener>> = {
		open: new Set(),
		message: new Set(),
		close: new Set(),
		error: new Set(),
	};
	let closed = false;
	let lastVersion = 0;
	const sent: string[] = [];

	function dispatch(type: SocketEventType, event: unknown): void {
		for (const listener of [...listeners[type]]) listener(event);
	}

	const socket: WebSocketLike = {
		addEventListener: (type, listener) => listeners[type].add(listener),
		removeEventListener: (type, listener) => listeners[type].delete(listener),
		send: (data) => {
			sent.push(data);
			if (data === "ping" && opts.echoPing) {
				dispatch("message", {
					data: JSON.stringify({ type: "version", version: lastVersion }),
				});
			}
		},
		close: () => {
			closed = true;
		},
		get readyState() {
			return closed ? 3 : 1;
		},
	};

	return {
		socket,
		open: () => dispatch("open", {}),
		pushVersion: (version) => {
			lastVersion = version;
			dispatch("message", {
				data: JSON.stringify({ type: "version", version }),
			});
		},
		sent,
		get closed() {
			return closed;
		},
	};
}

/** Builds a `WebSocketFactory` that hands out a fresh `FakeBroadcastSocket` per call (every initial connect AND every reconnect), collecting all of them so a test can inspect/drive each one. */
function createFakeBroadcastSocketFactory(opts: { echoPing: boolean }): {
	factory: WebSocketFactory;
	sockets: FakeBroadcastSocket[];
} {
	const sockets: FakeBroadcastSocket[] = [];
	const factory: WebSocketFactory = () => {
		const fake = createFakeBroadcastSocket(opts);
		sockets.push(fake);
		return fake.socket;
	};
	return { factory, sockets };
}

/** Drains the microtask queue (chained `await`s inside `resyncAfterReconnect`'s fetch call) without advancing real or fake time. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * Real WebSocket connections against the real Worker (via a real, in-memory
 * Miniflare instance) — bearer-auth mode, using a `ws`-backed factory (the
 * standard WebSocket API can't set the Authorization header the Worker's
 * `withAuth` middleware requires, which is exactly why
 * @mdly/cloudflare-client/node-ws exists; this test builds an equivalent
 * factory inline so it can also capture the raw sockets to simulate a real
 * connection drop).
 */
describe("createCloudflareSubscriber — real WebSocket against the real Worker (R2, R42)", () => {
	let worker: RealWorkerHandle;

	beforeAll(async () => {
		worker = await startRealWorker();
	}, 30000);

	afterAll(async () => {
		await worker.dispose();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function backend() {
		return createCloudflareBackend({
			baseUrl: worker.baseUrl,
			auth: { kind: "bearer", token: TEST_PASSWORD },
		});
	}

	function capturingFactory(): {
		factory: WebSocketFactory;
		sockets: NodeWebSocket[];
	} {
		const sockets: NodeWebSocket[] = [];
		const factory: WebSocketFactory = (url, opts) => {
			const socket = new NodeWebSocket(url, { headers: opts.headers });
			sockets.push(socket);
			return socket as unknown as WebSocketLike;
		};
		return { factory, sockets };
	}

	it("fires both onFilesChanged and onAssetsChanged when a mutation broadcasts (R2)", async () => {
		const workspaceId = await backend().createWorkspace("sub-broadcast-ws");
		const { factory } = capturingFactory();
		const subscriber = createCloudflareSubscriber({
			baseUrl: worker.baseUrl,
			auth: { kind: "bearer", token: TEST_PASSWORD },
			webSocketFactory: factory,
		});

		let filesFired = 0;
		let assetsFired = 0;
		const unsubFiles = subscriber.onFilesChanged(
			workspaceId,
			() => filesFired++,
			() => {},
		);
		const unsubAssets = subscriber.onAssetsChanged(
			workspaceId,
			() => assetsFired++,
			() => {},
		);

		// Give the socket a moment to actually open before pushing.
		await new Promise((r) => setTimeout(r, 200));
		await backend().pushFile({
			workspaceId,
			path: "note.md",
			contentHash: "h",
			content: "hi",
			deviceId: "device-a",
		});

		await waitFor(() => filesFired > 0 && assetsFired > 0);
		unsubFiles();
		unsubAssets();
		await subscriber.close();
	}, 15000);

	it("reconnect after a dropped connection re-checks the 1-row version and refires listeners — no manual reload (R42)", async () => {
		const workspaceId = await backend().createWorkspace("sub-reconnect-ws");

		const { factory, sockets } = capturingFactory();
		const subscriber = createCloudflareSubscriber({
			baseUrl: worker.baseUrl,
			auth: { kind: "bearer", token: TEST_PASSWORD },
			webSocketFactory: factory,
			heartbeatIntervalMs: 60000, // long enough that only the forced close drives reconnection in this test
		});

		let fireCount = 0;
		const unsubscribe = subscriber.onFilesChanged(
			workspaceId,
			() => fireCount++,
			() => {},
		);

		await waitFor(
			() =>
				sockets.length === 1 && sockets[0]!.readyState === NodeWebSocket.OPEN,
		);

		// Push a file WHILE the socket is live so the version bump reaches this
		// connection as a real broadcast, the same way `lastKnownVersion` is
		// populated in production — a subscriber that has been open for any
		// length of time has a fresh version, not a leftover 0 from before it
		// ever connected.
		await backend().pushFile({
			workspaceId,
			path: "before-drop.md",
			contentHash: "h1",
			content: "before",
			deviceId: "device-a",
		});
		await waitFor(() => fireCount > 0);

		// Baseline captured BEFORE the drop on purpose — see the assertion
		// at the end of this test for why taking it later cannot work.
		const firesBeforeDrop = fireCount;
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		// Simulate a real dropped connection (network blip, laptop sleep, etc.)
		// — not calling any subscriber method, just severing the socket the
		// way a real network failure would.
		sockets[0]!.terminate();

		// Meanwhile, another client pushes a change while we're "disconnected".
		await backend().pushFile({
			workspaceId,
			path: "during-drop.md",
			contentHash: "h2",
			content: "during",
			deviceId: "device-b",
		});

		// The subscriber must reconnect on its own and resync — no caller-invoked reload.
		await waitFor(() => sockets.length === 2, 10000);
		await waitFor(
			() =>
				fetchSpy.mock.calls.some((call) => {
					const url = String(call[0]);
					return (
						url.includes("/api/version") &&
						url.includes(`workspaceId=${workspaceId}`)
					);
				}),
			10000,
		);

		const resyncCall = fetchSpy.mock.calls.find((call) => {
			const url = String(call[0]);
			return (
				url.includes("/api/version") &&
				url.includes(`workspaceId=${workspaceId}`)
			);
		});
		expect(resyncCall).toBeTruthy();
		// The reconnect caused exactly the cheap version check — never a
		// full /api/files listing (the old shape re-read every row here and
		// then discarded the response).
		expect(
			fetchSpy.mock.calls.some((call) =>
				String(call[0]).includes("/api/files?"),
			),
		).toBe(false);

		// Another client wrote while we were disconnected, so the version
		// moved and listeners refire. The baseline is the pre-drop count,
		// NOT one taken here: the resync's notifyAll() can land while the
		// waitFor above is still polling for the /api/version call, so a
		// baseline taken at this point would already include that fire and
		// could never grow — the test would time out ~1 run in 3.
		await waitFor(() => fireCount > firesBeforeDrop, 10000);

		unsubscribe();
		await subscriber.close();
	}, 20000);

	it("unsubscribing the only listener closes the socket (no leaked connection, R25)", async () => {
		const workspaceId = await backend().createWorkspace("sub-unsub-ws");
		const { factory, sockets } = capturingFactory();
		const subscriber = createCloudflareSubscriber({
			baseUrl: worker.baseUrl,
			auth: { kind: "bearer", token: TEST_PASSWORD },
			webSocketFactory: factory,
		});
		const unsubscribe = subscriber.onFilesChanged(
			workspaceId,
			() => {},
			() => {},
		);
		await waitFor(
			() =>
				sockets.length === 1 && sockets[0]!.readyState === NodeWebSocket.OPEN,
		);
		unsubscribe();
		await waitFor(
			() =>
				sockets[0]!.readyState === NodeWebSocket.CLOSED ||
				sockets[0]!.readyState === NodeWebSocket.CLOSING,
		);
		await subscriber.close();
	}, 10000);

	it("bearer auth without an explicit webSocketFactory surfaces a clear error instead of silently connecting unauthenticated", async () => {
		const subscriber = createCloudflareSubscriber({
			baseUrl: worker.baseUrl,
			auth: { kind: "bearer", token: TEST_PASSWORD },
		});
		const errors: Error[] = [];
		subscriber.onFilesChanged(
			"any-workspace",
			() => {},
			(err) => errors.push(err),
		);
		await waitFor(() => errors.length > 0);
		expect(errors[0]?.message).toMatch(/webSocketFactory/);
		await subscriber.close();
	});
});

/**
 * The heartbeat itself (R42) — "the one thing Convex used to do for free".
 * These use a fake socket + `vi.useFakeTimers()` instead of the real Worker
 * above, because the whole point is to drive `startHeartbeat`'s
 * time-based staleness check deterministically and instantly, without a
 * real `close`/`error` event ever firing.
 */
describe("createCloudflareSubscriber — heartbeat detects a silently-dead connection (R42)", () => {
	const FAKE_BASE_URL = "https://fake.mdly.test";
	const WORKSPACE_ID = "fake-workspace";
	// Deliberately NOT a divisor/multiple of subscriber.ts's private
	// RECONNECT_DELAY_MS (1000ms) — see the reconnect-timing comment below
	// for why that matters.
	const HEARTBEAT_INTERVAL_MS = 400;

	function mockVersionFetch(version = 6) {
		return vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ version }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("a silently-dead connection (no close/error, just no more messages) is detected by the heartbeat, reconnects, and resyncs from the last known version", async () => {
		vi.useFakeTimers();
		try {
			const { factory, sockets } = createFakeBroadcastSocketFactory({
				echoPing: false, // the real-world case: the socket dies without so much as a close event, so even the ping goes unanswered
			});
			// The reconnect resync is the 1-row version check: it reports a
			// NEWER version (6) than the connection knew before it died (5),
			// i.e. something changed while we were gone.
			const fetchMock = mockVersionFetch(6);
			const subscriber = createCloudflareSubscriber({
				baseUrl: FAKE_BASE_URL,
				auth: { kind: "bearer", token: "test-token" },
				webSocketFactory: factory,
				heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
			});

			let fireCount = 0;
			subscriber.onFilesChanged(
				WORKSPACE_ID,
				() => fireCount++,
				() => {},
			);

			await flushMicrotasks(); // let the constructor's queueMicrotask-deferred connect() run
			expect(sockets).toHaveLength(1);
			sockets[0]!.open();
			// A real broadcast reaches this connection before it dies, the same
			// way `lastKnownVersion` is populated in production — not a leftover
			// 0 from before it ever connected.
			sockets[0]!.pushVersion(5);
			fireCount = 0;

			// One heartbeat interval of silence: a ping goes out but nothing
			// comes back — not stale yet (`staleFor > interval * 2` needs MORE
			// than two full intervals).
			await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
			expect(sockets[0]!.closed).toBe(false);

			// Two full intervals of silence: still not torn down — `staleFor`
			// is exactly `interval * 2` here, and the check is strictly greater.
			await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
			expect(sockets[0]!.closed).toBe(false);
			expect(sockets).toHaveLength(1);

			// The third tick pushes staleness past the two-interval threshold —
			// this is the heartbeat noticing the dead connection on its own.
			await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
			expect(sockets[0]!.closed).toBe(true);

			// subscriber.ts's private RECONNECT_DELAY_MS is 1000ms. 400 * 3 (=
			// 1200, when the stale socket was torn down) + 1000 = 2200, which
			// isn't a multiple of 400 — so this reconnect can't land on the same
			// simulated instant as one of the (harmless, but still-running)
			// leftover heartbeat ticks from the torn-down connection's interval.
			await vi.advanceTimersByTimeAsync(1000);
			expect(sockets).toHaveLength(2);
			sockets[1]!.open();
			await flushMicrotasks();

			const resyncCall = fetchMock.mock.calls.find((call) => {
				const url = String(call[0]);
				return url.includes("/api/version");
			});
			expect(resyncCall).toBeTruthy();
			// The resync was the cheap version check — never a full listing.
			expect(
				fetchMock.mock.calls.some((call) =>
					String(call[0]).includes("/api/files"),
				),
			).toBe(false);
			expect(fireCount).toBeGreaterThan(0); // listeners refired after the heartbeat-driven resync

			await subscriber.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("a healthy but idle connection is never torn down, because the server's ping-echo keeps it fresh", async () => {
		vi.useFakeTimers();
		try {
			const { factory, sockets } = createFakeBroadcastSocketFactory({
				echoPing: true, // matches workspaceDurableObject.ts's webSocketMessage echoing {type:"version"} back in reply to "ping"
			});
			const subscriber = createCloudflareSubscriber({
				baseUrl: FAKE_BASE_URL,
				auth: { kind: "bearer", token: "test-token" },
				webSocketFactory: factory,
				heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
			});

			const errors: Error[] = [];
			subscriber.onFilesChanged(
				WORKSPACE_ID,
				() => {},
				(err) => errors.push(err),
			);

			await flushMicrotasks();
			expect(sockets).toHaveLength(1);
			sockets[0]!.open();

			// Several heartbeat cycles pass with nothing but the ping/pong
			// keeping the connection "warm" — no mutation ever broadcasts on it.
			await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 6);

			expect(sockets[0]!.closed).toBe(false); // never torn down
			expect(sockets).toHaveLength(1); // never reconnected
			expect(
				sockets[0]!.sent.filter((payload) => payload === "ping").length,
			).toBeGreaterThanOrEqual(5);
			expect(errors).toHaveLength(0);

			await subscriber.close();
		} finally {
			vi.useRealTimers();
		}
	});
});
