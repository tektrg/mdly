import { describe, expect, it } from "vitest";
import { authedJson, fetchWithBearer, jsonBody } from "./testHelpers.js";

async function registerDevice(workspaceId: string, deviceId: string) {
	return authedJson<{ slot: number }>("/api/device/register", {
		method: "POST",
		...jsonBody({ workspaceId, deviceId }),
	});
}

async function pushComment(
	workspaceId: string,
	path: string,
	deviceId: string,
) {
	return authedJson<
		{ ok: true; version: number } | { error: string; code: string }
	>("/api/files", {
		method: "POST",
		...jsonBody({
			workspaceId,
			path,
			contentHash: "h",
			content: "comment",
			deviceId,
		}),
	});
}

describe("device slot registration (R3)", () => {
	it("assigns distinct integer slots starting at 2", async () => {
		const workspaceId = "slots-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const first = await registerDevice(workspaceId, "browser-a");
		const second = await registerDevice(workspaceId, "browser-b");

		expect(first.body.slot).toBe(2);
		expect(second.body.slot).toBe(3);
	});

	it("QA4a — registering the same device id twice is idempotent (same slot, one row)", async () => {
		const workspaceId = "slots-ws-idempotent";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const first = await registerDevice(workspaceId, "browser-a");
		const second = await registerDevice(workspaceId, "browser-a");

		expect(first.body.slot).toBe(second.body.slot);
	});

	it("device-slots-only-for-browsers — a bearer-token (desktop/CLI) request never needs to register a slot", async () => {
		const workspaceId = "slots-ws-desktop";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		// No prior /api/device/register call for this deviceId at all.
		const push = await pushComment(workspaceId, "note.md", "desktop-device");
		expect(push.status).toBe(200);
	});
});

describe("server-enforced comment-log slot invariant (R4)", () => {
	it("a device may write its OWN slot-suffixed comment log", async () => {
		const workspaceId = "slot-invariant-ws";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const { body } = await registerDevice(workspaceId, "browser-a");

		const push = await pushComment(
			workspaceId,
			`.mdly/comments/doc ${body.slot}.jsonl`,
			"browser-a",
		);
		expect(push.status).toBe(200);
	});

	it("rejects a write to another device's slot-suffixed comment log", async () => {
		const workspaceId = "slot-invariant-ws-mismatch";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		const a = await registerDevice(workspaceId, "browser-a");
		await registerDevice(workspaceId, "browser-b");

		// browser-b tries to write into browser-a's slot file.
		const push = await pushComment(
			workspaceId,
			`.mdly/comments/doc ${a.body.slot}.jsonl`,
			"browser-b",
		);
		expect(push.status).toBe(403);
		const body = push.body as { code: string };
		expect(body.code).toBe("SLOT_INVARIANT_VIOLATION");
	});

	it("rejects any browser write to the canonical (unsuffixed) comment log", async () => {
		const workspaceId = "slot-invariant-ws-canonical";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		await registerDevice(workspaceId, "browser-a");

		const push = await pushComment(
			workspaceId,
			".mdly/comments/doc.jsonl",
			"browser-a",
		);
		expect(push.status).toBe(403);
	});

	it("allows the desktop/CLI (never registered) to write the canonical comment log", async () => {
		const workspaceId = "slot-invariant-ws-desktop-canonical";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});

		const push = await pushComment(
			workspaceId,
			".mdly/comments/doc.jsonl",
			"desktop-device",
		);
		expect(push.status).toBe(200);
	});

	it("a non-comment-log path is never subject to the slot invariant", async () => {
		const workspaceId = "slot-invariant-ws-unrelated";
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: workspaceId }),
		});
		await registerDevice(workspaceId, "browser-a");

		const push = await pushComment(workspaceId, "regular-note.md", "browser-a");
		expect(push.status).toBe(200);
	});
});
