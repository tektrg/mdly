// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Integration tests for R34 (workspace switch fully swaps visible data), R35
 * (the live subscription always tracks the selected workspace), R36 (a
 * workspace whose sync is turned off mid-view closes cleanly), and R37 (an
 * empty workspace shows an explicit message). Real `AppShell` + real
 * `@mdly/cloudflare-client` (createCloudflareBackend/createCloudflareSubscriber/
 * listWorkspaces) against a fully-mocked `fetch` and a fake, script-driven
 * `WebSocket` — no real network, no real Worker, matching this monorepo's
 * existing no-RTL, happy-dom + react-dom/client convention (see
 * packages/workspace-kit/src/ui/EditorView.test.tsx).
 */

type FixtureFile = {
	path: string;
	content: string;
	contentHash: string;
	updatedAt: number;
	deleted?: boolean;
};

type Fixture = {
	workspaces: { workspaceId: string; name: string }[];
	files: Record<string, FixtureFile[]>;
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function installFetchMock(fixture: Fixture) {
	const calls: { pathname: string; workspaceId: string | null }[] = [];
	const fetchMock = vi.fn(async (input: unknown) => {
		const raw =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: (input as Request).url;
		const url = new URL(raw);
		const workspaceId = url.searchParams.get("workspaceId");
		calls.push({ pathname: url.pathname, workspaceId });

		if (url.pathname === "/api/workspaces") {
			return jsonResponse({ workspaces: fixture.workspaces });
		}
		if (url.pathname === "/api/files") {
			const files = (fixture.files[workspaceId ?? ""] ?? []).map((f, i) => ({
				_id: `id-${workspaceId}-${i}`,
				path: f.path,
				contentHash: f.contentHash,
				content: f.content,
				updatedAt: f.updatedAt,
				deviceId: "device-mac",
				deleted: f.deleted ?? false,
			}));
			const includeDeleted = url.searchParams.get("includeDeleted") === "true";
			return jsonResponse({
				files: includeDeleted ? files : files.filter((f) => !f.deleted),
			});
		}
		if (url.pathname === "/api/assets") {
			return jsonResponse({ assets: [] });
		}
		throw new Error(`unmocked fetch in test: ${url.pathname}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, calls };
}

/** Minimal WebSocketLike stand-in, scriptable per-instance so a test can fire a version broadcast at will and inspect close state (R35, R36). */
class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	url: string;
	readyState = 0;
	private listeners = new Map<string, Set<(event: unknown) => void>>();

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => {
			if (this.readyState === 3) return;
			this.readyState = 1;
			this.dispatch("open", {});
		});
	}
	addEventListener(type: string, cb: (event: unknown) => void) {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(cb);
	}
	removeEventListener(type: string, cb: (event: unknown) => void) {
		this.listeners.get(type)?.delete(cb);
	}
	send(_data: string) {}
	close() {
		this.readyState = 3;
		this.dispatch("close", {});
	}
	dispatch(type: string, event: unknown) {
		for (const cb of [...(this.listeners.get(type) ?? [])]) cb(event);
	}
	broadcastVersion(version: number) {
		this.dispatch("message", {
			data: JSON.stringify({ type: "version", version }),
		});
	}
}

function socketFor(workspaceId: string): FakeWebSocket {
	const match = [...FakeWebSocket.instances]
		.reverse()
		.find((ws) => ws.url.includes(encodeURIComponent(workspaceId)));
	if (!match) throw new Error(`no socket opened for workspace ${workspaceId}`);
	return match;
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

const NOOP = () => {};

describe("AppShell workspace switching + subscription lifecycle (R34, R35, R36, R37)", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		vi.stubGlobal("WebSocket", FakeWebSocket);
		FakeWebSocket.instances = [];
		localStorage.clear();
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	function renderShell(workspaceId: string, filePath: string | null = null) {
		act(() => {
			root.render(
				<AppShell
					workspaceId={workspaceId}
					filePath={filePath}
					onSelectFile={NOOP}
					onSwitch={NOOP}
					onUnauthorized={NOOP}
					onLogout={NOOP}
				/>,
			);
		});
	}

	it("R34: selecting a different workspace fully swaps the file list and open note, no stale rows", async () => {
		const fixture: Fixture = {
			workspaces: [
				{ workspaceId: "alpha", name: "Alpha" },
				{ workspaceId: "beta", name: "Beta" },
			],
			files: {
				alpha: [
					{
						path: "alpha-note.md",
						content: "Alpha body text",
						contentHash: "hash-a1",
						updatedAt: 1,
					},
				],
				beta: [
					{
						path: "beta-note.md",
						content: "Beta body text",
						contentHash: "hash-b1",
						updatedAt: 1,
					},
				],
			},
		};
		installFetchMock(fixture);

		renderShell("alpha", "alpha-note.md");
		await flush();

		expect(container.textContent).toContain("alpha-note");
		expect(container.textContent).toContain("Alpha body text");
		expect(container.textContent).not.toContain("beta-note");
		expect(container.textContent).not.toContain("Beta body text");

		renderShell("beta", "beta-note.md");
		await flush();

		expect(container.textContent).toContain("beta-note");
		expect(container.textContent).toContain("Beta body text");
		expect(container.textContent).not.toContain("alpha-note");
		expect(container.textContent).not.toContain("Alpha body text");
	});

	it("R35: the live subscription follows the selected workspace across two switches", async () => {
		const fixture: Fixture = {
			workspaces: [
				{ workspaceId: "alpha", name: "Alpha" },
				{ workspaceId: "beta", name: "Beta" },
			],
			files: {
				alpha: [
					{
						path: "alpha-note.md",
						content: "Alpha v1",
						contentHash: "hash-a1",
						updatedAt: 1,
					},
				],
				beta: [
					{
						path: "beta-note.md",
						content: "Beta v1",
						contentHash: "hash-b1",
						updatedAt: 1,
					},
				],
			},
		};
		const { calls } = installFetchMock(fixture);

		renderShell("alpha");
		await flush();
		const alphaSocket = socketFor("alpha");
		expect(alphaSocket.readyState).toBe(1); // open

		renderShell("beta");
		await flush();

		// Switching tore down alpha's socket and opened a new one for beta.
		expect(alphaSocket.readyState).toBe(3); // closed
		const betaSocket = socketFor("beta");
		expect(betaSocket).not.toBe(alphaSocket);
		expect(betaSocket.readyState).toBe(1);

		// A change pushed to the now-unselected workspace (alpha) must never be
		// rendered / must not even trigger a refetch — its socket is closed and
		// its listeners were removed by teardownSocket.
		const filesCallsBefore = calls.filter(
			(c) => c.pathname === "/api/files",
		).length;
		fixture.files.alpha = [
			{
				path: "alpha-note.md",
				content: "Alpha v2 (should never be seen)",
				contentHash: "hash-a2",
				updatedAt: 2,
			},
		];
		alphaSocket.broadcastVersion(2);
		await flush();
		const filesCallsAfterStaleBroadcast = calls.filter(
			(c) => c.pathname === "/api/files",
		).length;
		expect(filesCallsAfterStaleBroadcast).toBe(filesCallsBefore);
		expect(container.textContent).not.toContain("Alpha v2");

		// A change pushed to the currently-selected workspace (beta) DOES
		// trigger a refetch and IS rendered.
		fixture.files.beta = [
			{
				path: "beta-note.md",
				content: "Beta v2",
				contentHash: "hash-b2",
				updatedAt: 2,
			},
		];
		betaSocket.broadcastVersion(2);
		await flush();
		const filesCallsAfterLiveBroadcast = calls.filter(
			(c) => c.pathname === "/api/files",
		).length;
		expect(filesCallsAfterLiveBroadcast).toBeGreaterThan(
			filesCallsAfterStaleBroadcast,
		);
	});

	it("R36: turning off the viewed workspace's sync closes the subscription and shows a clear message", async () => {
		const fixture: Fixture = {
			workspaces: [{ workspaceId: "alpha", name: "Alpha" }],
			files: {
				alpha: [
					{
						path: "alpha-note.md",
						content: "Alpha body",
						contentHash: "hash-a1",
						updatedAt: 1,
					},
				],
			},
		};
		installFetchMock(fixture);

		// Fake timers must be active BEFORE the initial render — AppShell's
		// availability-poll `setInterval` is registered during that render's
		// effects, and a real interval started before `useFakeTimers()` is
		// enabled is not something fake-timer advancement can ever fire.
		vi.useFakeTimers();

		renderShell("alpha", "alpha-note.md");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);
		});
		const alphaSocket = socketFor("alpha");
		expect(alphaSocket.readyState).toBe(1);
		expect(container.textContent).toContain("Alpha body");

		// Simulate the Mac turning cloud sync off for this workspace: the
		// registry (GET /api/workspaces) no longer lists it. Nothing pushes
		// this to the browser (see checkWorkspaceAvailable's doc comment) —
		// the poll is what finds out.
		fixture.workspaces = [];
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});

		expect(alphaSocket.readyState).toBe(3); // subscription closed cleanly
		expect(container.textContent).toContain(
			"This workspace's cloud sync was turned off.",
		);
		expect(container.textContent).not.toContain("Alpha body");
	});

	it("R37: a workspace with zero notes renders an explicit empty-workspace message", async () => {
		const fixture: Fixture = {
			workspaces: [{ workspaceId: "empty-ws", name: "Empty" }],
			files: { "empty-ws": [] },
		};
		installFetchMock(fixture);

		renderShell("empty-ws");
		await flush();

		const empty = container.querySelector('[data-testid="empty-workspace"]');
		expect(empty).not.toBeNull();
		expect(empty?.textContent).toContain("This workspace has no notes yet.");
	});

	it("R39: a total network failure fails honestly and visibly — no cached/stale content, no silent blank screen", async () => {
		// apps/www has no offline/cached mode (see the charter's locked
		// decision) — every request goes through packages/cloudflare-client's
		// `requestJson`, which wraps a rejected `fetch` (network down, DNS
		// failure, etc.) as `CloudflareResponseError(..., 0)`; apps/www's own
		// `describeApiError` (src/connection/apiError.ts) turns status 0 into a
		// specific, human-readable message rather than a raw stack trace.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
		);

		renderShell("alpha", "alpha-note.md");
		await flush();

		expect(container.textContent).toContain(
			"Couldn't reach the server. Check your connection.",
		);
		// Nothing from a previous session/workspace leaks through as if it
		// were live content, and no subscription is ever opened over data
		// that was never actually fetched.
		expect(container.textContent).not.toContain("alpha-note");
		expect(container.textContent).not.toContain("Alpha body");
		expect(FakeWebSocket.instances.length).toBe(0);
	});
});
