import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudflareBackend } from "./backend.js";
import {
	createCloudflareSubscriber,
	type WebSocketFactory,
	type WebSocketLike,
} from "./subscriber.js";
import { createVersionLedger, DEFAULT_LEDGER_CAP } from "./versionLedger.js";

/**
 * DO row-read frequency fix, 2b: exact-membership self-echo suppression.
 * A version this client produced is suppressed; anything else — including a
 * numerically LOWER version from another device — is not.
 */

type SocketEventType = "open" | "message" | "close" | "error";
// biome-ignore lint/suspicious/noExplicitAny: mirrors WebSocketLike's listener signature.
type SocketEventListener = (event: any) => void;

function createFakeSocket() {
	const listeners: Record<SocketEventType, Set<SocketEventListener>> = {
		open: new Set(),
		message: new Set(),
		close: new Set(),
		error: new Set(),
	};
	const socket: WebSocketLike = {
		addEventListener: (type, listener) => listeners[type].add(listener),
		removeEventListener: (type, listener) => listeners[type].delete(listener),
		send: () => {},
		close: () => {},
		get readyState() {
			return 1;
		},
	};
	return {
		socket,
		open: () => {
			for (const listener of [...listeners.open]) listener({});
		},
		pushVersion: (version: number) => {
			for (const listener of [...listeners.message])
				listener({ data: JSON.stringify({ type: "version", version }) });
		},
	};
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("createVersionLedger", () => {
	it("records and reports exact membership", () => {
		const ledger = createVersionLedger();
		expect(ledger.has(42)).toBe(false);
		ledger.record(42);
		expect(ledger.has(42)).toBe(true);
		expect(ledger.size()).toBe(1);
	});

	it("is bounded and does not grow without limit", () => {
		const ledger = createVersionLedger();
		for (let v = 1; v <= DEFAULT_LEDGER_CAP + 50; v++) ledger.record(v);
		expect(ledger.size()).toBe(DEFAULT_LEDGER_CAP);
		// The oldest entries were evicted; the newest are kept.
		expect(ledger.has(1)).toBe(false);
		expect(ledger.has(50)).toBe(false);
		expect(ledger.has(51)).toBe(true);
		expect(ledger.has(DEFAULT_LEDGER_CAP + 50)).toBe(true);
	});

	it("re-recording an existing version does not disturb the bound", () => {
		const ledger = createVersionLedger(3);
		ledger.record(1);
		ledger.record(2);
		ledger.record(3);
		ledger.record(2);
		expect(ledger.size()).toBe(3);
		expect(ledger.has(1)).toBe(true);
	});
});

describe("subscriber self-echo suppression via the shared ledger", () => {
	async function setup() {
		const ledger = createVersionLedger();
		const fake = createFakeSocket();
		const factory: WebSocketFactory = () => fake.socket;
		const subscriber = createCloudflareSubscriber({
			baseUrl: "https://fake.mdly.test",
			auth: { kind: "bearer", token: "t" },
			webSocketFactory: factory,
			versionLedger: ledger,
		});
		let fires = 0;
		subscriber.onFilesChanged(
			"ws-1",
			() => fires++,
			() => {},
		);
		await flushMicrotasks();
		fake.open();
		return { ledger, fake, subscriber, fires: () => fires };
	}

	it("suppresses a version this client produced", async () => {
		const { ledger, fake, subscriber, fires } = await setup();
		ledger.record(10);
		fake.pushVersion(10);
		expect(fires()).toBe(0);
		await subscriber.close();
	});

	it("does NOT suppress a different device's version — including one numerically lower than this client's most recent", async () => {
		const { ledger, fake, subscriber, fires } = await setup();
		// This client produced version 10 (its most recent write).
		ledger.record(10);
		// Another device's change lands with a LOWER number (its write raced
		// ours and committed first). A `<=` rule would swallow this — exact
		// membership must not.
		fake.pushVersion(7);
		expect(fires()).toBe(1);
		// A higher foreign version fires too.
		fake.pushVersion(12);
		expect(fires()).toBe(2);
		// But our own echo still does not.
		fake.pushVersion(10);
		expect(fires()).toBe(2);
		await subscriber.close();
	});

	it("without a ledger every broadcast notifies, like before", async () => {
		const fake = createFakeSocket();
		const subscriber = createCloudflareSubscriber({
			baseUrl: "https://fake.mdly.test",
			auth: { kind: "bearer", token: "t" },
			webSocketFactory: () => fake.socket,
		});
		let fires = 0;
		subscriber.onFilesChanged(
			"ws-1",
			() => fires++,
			() => {},
		);
		await flushMicrotasks();
		fake.open();
		fake.pushVersion(3);
		expect(fires).toBe(1);
		await subscriber.close();
	});
});

describe("backend records mutation versions into the shared ledger", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubFetch(version: number) {
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown) => {
				const url = String(input);
				seen.push(url);
				if (url.includes("/api/files/batch")) {
					return jsonResponse({ ok: true, version });
				}
				if (url.includes("/api/version")) {
					return jsonResponse({ version });
				}
				return jsonResponse({ ok: true, version });
			}),
		);
		return seen;
	}

	it("pushFile records its version; pushFilesBatch returns and records its version", async () => {
		const seen = stubFetch(77);
		const ledger = createVersionLedger();
		const backend = createCloudflareBackend({
			baseUrl: "https://fake.mdly.test",
			auth: { kind: "bearer", token: "t" },
			versionLedger: ledger,
		});
		await backend.pushFile({
			workspaceId: "ws-1",
			path: "a.md",
			contentHash: "h",
			content: "hi",
			deviceId: "d",
		});
		expect(ledger.has(77)).toBe(true);

		const returned = await backend.pushFilesBatch!({
			workspaceId: "ws-1",
			files: [{ path: "b.md", contentHash: "h", content: "yo", deviceId: "d" }],
		});
		expect(returned).toBe(77);
		expect(seen.some((url) => url.includes("/api/files/batch"))).toBe(true);
	});

	it("softDeleteFile records its version; getVersion reads without recording", async () => {
		stubFetch(5);
		const ledger = createVersionLedger();
		const backend = createCloudflareBackend({
			baseUrl: "https://fake.mdly.test",
			auth: { kind: "bearer", token: "t" },
			versionLedger: ledger,
		});
		await backend.softDeleteFile({
			workspaceId: "ws-1",
			path: "gone.md",
			deviceId: "d",
		});
		expect(ledger.has(5)).toBe(true);

		stubFetch(9);
		const version = await backend.getVersion!("ws-1");
		expect(version).toBe(9);
		// A read is not a mutation — it must not pollute the echo ledger.
		expect(ledger.has(9)).toBe(false);
	});

	it("without a ledger the backend still works and returns versions", async () => {
		stubFetch(3);
		const backend = createCloudflareBackend({
			baseUrl: "https://fake.mdly.test",
			auth: { kind: "bearer", token: "t" },
		});
		await backend.pushFile({
			workspaceId: "ws-1",
			path: "a.md",
			contentHash: "h",
			content: "hi",
			deviceId: "d",
		});
		expect(await backend.getVersion!("ws-1")).toBe(3);
	});
});
