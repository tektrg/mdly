import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudflareBackend } from "./backend.js";
import { registerDeviceSlot } from "./devices.js";
import type { RealWorkerHandle } from "./testHarness/realWorker.js";
import { startRealWorker, TEST_PASSWORD } from "./testHarness/realWorker.js";

/**
 * registerDeviceSlot (web write-back slice 6 / server Step 8) — proven
 * end-to-end against the real bundled Worker: first registration mints a
 * slot, re-registration is idempotent, a second device gets its own slot.
 */
describe("registerDeviceSlot", () => {
	let worker: RealWorkerHandle;

	beforeAll(async () => {
		worker = await startRealWorker();
	}, 30000);

	afterAll(async () => {
		await worker.dispose();
	});

	function authed(workspaceId: string, deviceId: string, label?: string) {
		return {
			baseUrl: worker.baseUrl,
			auth: { kind: "bearer", token: TEST_PASSWORD } as const,
			workspaceId,
			deviceId,
			...(label !== undefined ? { label } : {}),
		};
	}

	it("mints a slot on first registration and returns it idempotently", async () => {
		const backend = createCloudflareBackend({
			baseUrl: worker.baseUrl,
			auth: { kind: "bearer", token: TEST_PASSWORD },
		});
		const workspaceId = await backend.createWorkspace("devices-slot-a");
		const first = await registerDeviceSlot(
			authed(workspaceId, "web-device-1", "Test Browser"),
		);
		expect(typeof first).toBe("number");
		const second = await registerDeviceSlot(
			authed(workspaceId, "web-device-1", "Test Browser"),
		);
		expect(second).toBe(first);
	});

	it("a second device gets a different slot in the same workspace", async () => {
		const backend = createCloudflareBackend({
			baseUrl: worker.baseUrl,
			auth: { kind: "bearer", token: TEST_PASSWORD },
		});
		const workspaceId = await backend.createWorkspace("devices-slot-b");
		const slotA = await registerDeviceSlot(authed(workspaceId, "web-device-a"));
		const slotB = await registerDeviceSlot(authed(workspaceId, "web-device-b"));
		expect(slotB).not.toBe(slotA);
	});
});
