import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fetchWithBearer, jsonBody, TEST_PASSWORD } from "./testHelpers.js";

async function openWorkspaceSocket(workspaceId: string): Promise<WebSocket> {
	const response = await SELF.fetch(
		`https://garden.test/api/workspace/${workspaceId}/socket`,
		{
			headers: {
				Upgrade: "websocket",
				Authorization: `Bearer ${TEST_PASSWORD}`,
			},
		},
	);
	const ws = response.webSocket;
	if (!ws) throw new Error("expected a WebSocket in the upgrade response");
	ws.accept();
	return ws;
}

function nextMessage(
	ws: WebSocket,
): Promise<{ type: string; version: number }> {
	return new Promise((resolve, reject) => {
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
	});
}

async function pushFile(workspaceId: string, path: string): Promise<void> {
	await fetchWithBearer("/api/files", {
		method: "POST",
		...jsonBody({
			workspaceId,
			path,
			contentHash: "h",
			content: "hi",
			deviceId: "device-a",
		}),
	});
}

/** O2-broadcast-fast-refetch (R2): a write bumps the version counter and broadcasts to open sockets. */
describe("hibernating WebSocket broadcast on every mutating write (R2)", () => {
	it("an open socket receives a version-bump message after another client's pushFile", async () => {
		const workspaceId = "broadcast-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const ws = await openWorkspaceSocket(workspaceId);
		const messageArrived = nextMessage(ws);

		await pushFile(workspaceId, "note.md");

		const message = await messageArrived;
		expect(message.type).toBe("version");
		expect(message.version).toBeGreaterThan(0);

		ws.close();
	});

	it("two open sockets on the same workspace both receive the same broadcast", async () => {
		const workspaceId = "broadcast-ws-two-clients";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const wsA = await openWorkspaceSocket(workspaceId);
		const wsB = await openWorkspaceSocket(workspaceId);

		const messageA = nextMessage(wsA);
		const messageB = nextMessage(wsB);

		await pushFile(workspaceId, "note.md");

		const [a, b] = await Promise.all([messageA, messageB]);
		expect(a.version).toBe(b.version);

		wsA.close();
		wsB.close();
	});
});
