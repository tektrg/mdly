import { authFetchInit, authHeaders, type CloudflareAuth } from "./auth.js";
import { buildUrl, jsonRequestInit, requestJson } from "./httpClient.js";
import { RegisterDeviceResponseSchema } from "./schemas.js";

/**
 * POST /api/device/register {workspaceId, deviceId, label?} — assigns the
 * browser a comment-log slot for the workspace (server Step 8). Idempotent:
 * re-registering the same deviceId returns its existing slot. Only ever
 * called by browsers; desktop/CLI authenticate by bearer token alone.
 */
export async function registerDeviceSlot(options: {
	baseUrl: string;
	auth: CloudflareAuth;
	workspaceId: string;
	deviceId: string;
	label?: string;
}): Promise<number> {
	const data = await requestJson(
		buildUrl(options.baseUrl, "/api/device/register"),
		{
			...jsonRequestInit(
				{
					workspaceId: options.workspaceId,
					deviceId: options.deviceId,
					...(options.label !== undefined ? { label: options.label } : {}),
				},
				authHeaders(options.auth),
			),
			...authFetchInit(options.auth),
		},
		RegisterDeviceResponseSchema,
		"registerDeviceSlot",
	);
	return data.slot;
}
