import { FieldTooLargeError } from "../durableObject/errors.js";
import { MAX_FIELD_BYTES } from "../durableObject/workspaceDurableObject.js";
import type { Env } from "../env.js";
import {
	forbiddenDeviceIdResponse,
	json,
	readJsonBody,
	requestTooLargeResponse,
	utf8ByteLength,
} from "../http.js";
import { workspaceStub } from "./workspaceStub.js";

/** 413 when one scalar field exceeds the SQLite-safe ceiling (see files.ts). */
function oversizedFieldResponse(field: string, value: string): Response | null {
	const bytes = utf8ByteLength(value);
	if (bytes > MAX_FIELD_BYTES) {
		const error = new FieldTooLargeError(field, bytes, MAX_FIELD_BYTES);
		return json({ error: error.message, code: error.code }, { status: 413 });
	}
	return null;
}

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
	if (
		!body?.workspaceId ||
		!body.deviceId ||
		(body.label !== undefined && typeof body.label !== "string")
	) {
		return json(
			{
				error:
					"workspaceId and deviceId are required; label must be a string when present",
			},
			{ status: 400 },
		);
	}
	const tooLarge = requestTooLargeResponse(body);
	if (tooLarge) return tooLarge;
	const badDevice = forbiddenDeviceIdResponse(body.deviceId);
	if (badDevice) return badDevice;
	const badField =
		oversizedFieldResponse("deviceId", body.deviceId) ??
		(body.label !== undefined
			? oversizedFieldResponse("label", body.label)
			: null);
	if (badField) return badField;
	const result = await workspaceStub(env, body.workspaceId).registerDeviceSlot(
		body.deviceId,
		body.label,
	);
	if (!result.ok) {
		return json(
			{ error: result.message, code: result.code },
			{ status: result.code === "FIELD_TOO_LARGE" ? 413 : 500 },
		);
	}
	return json({ slot: result.device.slot });
}
