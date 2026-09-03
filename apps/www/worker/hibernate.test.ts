import { evictDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	fetchWithBearer,
	jsonBody,
	TEST_PASSWORD,
	workspaceDoStub,
} from "./testHelpers.js";

/**
 * QA11a (R2): the DO must still broadcast correctly after being evicted
 * (hibernated) and re-constructed to handle the very mutation that wakes it.
 * `evictDurableObject` tears down the DO's in-memory JS state while
 * preserving durable storage and — per its default `webSockets: "hibernate"`
 * — hibernating rather than closing any accepted WebSocket. This is real
 * eviction/wake behavior from the Workers runtime test harness, not a
 * hand-simulated stand-in for it.
 */
describe("broadcast survives Durable Object eviction/hibernation (R2)", () => {
	it("a socket accepted before eviction still receives the broadcast for the mutation that wakes the DO", async () => {
		const workspaceId = "hibernate-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const upgrade = await SELF.fetch(
			`https://garden.test/api/workspace/${workspaceId}/socket`,
			{
				headers: {
					Upgrade: "websocket",
					Authorization: `Bearer ${TEST_PASSWORD}`,
				},
			},
		);
		const ws = upgrade.webSocket;
		if (!ws) throw new Error("expected a WebSocket in the upgrade response");
		ws.accept();

		const stub = workspaceDoStub(workspaceId);
		await evictDurableObject(stub); // tears down in-memory state; hibernates the socket

		const messageArrived = new Promise<{ type: string; version: number }>(
			(resolve, reject) => {
				const timeout = setTimeout(
					() => reject(new Error("timed out waiting for a message")),
					5000,
				);
				ws.addEventListener(
					"message",
					(event: MessageEvent) => {
						clearTimeout(timeout);
						resolve(JSON.parse(event.data as string));
					},
					{ once: true },
				);
			},
		);

		// This push is what wakes the (now-evicted) DO back up — a fresh
		// instance is constructed, with no memory of the socket beyond what
		// `ctx.getWebSockets()` (backed by the runtime, not our code) reports.
		await fetchWithBearer("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "note.md",
				contentHash: "h",
				content: "written after hibernation",
				deviceId: "device-a",
			}),
		});

		const message = await messageArrived;
		expect(message.type).toBe("version");
		expect(message.version).toBeGreaterThan(0);

		ws.close();
	});

	it("the version counter itself survives eviction (durable storage, not in-memory state)", async () => {
		const workspaceId = "hibernate-ws-counter";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		await fetchWithBearer("/api/files", {
			method: "POST",
			...jsonBody({
				workspaceId,
				path: "a.md",
				contentHash: "h",
				content: "1",
				deviceId: "d",
			}),
		});

		const stub = workspaceDoStub(workspaceId);
		const versionBeforeEviction = await stub.getVersion();
		await evictDurableObject(stub);
		const versionAfterEviction = await stub.getVersion();

		expect(versionAfterEviction).toBe(versionBeforeEviction);
	});
});
