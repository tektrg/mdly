import type { Env } from "../env.js";
import { json, readJsonBody } from "../http.js";
import { workspaceStub } from "./workspaceStub.js";

/**
 * POST /api/device/register {workspaceId, deviceId, label?} — R3. Only ever
 * called by browsers (apps/www's `deviceId.ts` mints the uuid); the desktop
 * app and CLI authenticate by bearer token alone and never hit this route.
 * Idempotent: registering the same deviceId twice returns the same slot.
 */
export async function handleRegisterDevice(
	request: Request,
	env: Env,
): Promise<Response> {
	const body = await readJsonBody<{
		workspaceId?: string;
		deviceId?: string;
		label?: string;
	}>(request);
	if (!body?.workspaceId || !body.deviceId) {
		return json(
			{ error: "workspaceId and deviceId are required" },
			{ status: 400 },
		);
	}
	const device = await workspaceStub(env, body.workspaceId).registerDeviceSlot(
		body.deviceId,
		body.label,
	);
	return json({ slot: device.slot });
}
