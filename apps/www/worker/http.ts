import { containsForbiddenChars } from "./paths.js";
import { RequestTooLargeError } from "./durableObject/errors.js";

export function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("Content-Type", "application/json");
	return new Response(JSON.stringify(data), { ...init, headers });
}

export async function readJsonBody<T>(request: Request): Promise<T | null> {
	try {
		return (await request.json()) as T;
	} catch {
		return null;
	}
}

/**
 * Maximum total request-body bytes accepted on write routes — well under the
 * ~32MiB Workers RPC argument ceiling. Content-only caps can't cover the
 * other fields (`contentHash`, `deviceId`, `path`…), and the 1024-char path
 * cap lives inside the DO, *after* the RPC boundary — so without this,
 * a 33MB `deviceId` dies inside RPC with a 500 leaking internals. Checked
 * after shape validation, before any RPC call, on every write route.
 */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/** Returns a clean 413 when the parsed body serialises over the cap, else null. */
export function requestTooLargeResponse(body: unknown): Response | null {
	let size = 0;
	try {
		size = JSON.stringify(body)?.length ?? 0;
	} catch {
		size = Number.MAX_SAFE_INTEGER; // unserialisable — reject, don't probe further
	}
	if (size > MAX_REQUEST_BYTES) {
		const error = new RequestTooLargeError(size, MAX_REQUEST_BYTES);
		return json(
			{ error: error.message, code: error.code },
			{ status: 413 },
		);
	}
	return null;
}

/**
 * 400 when a deviceId carries characters forbidden in stored paths/ids
 * (same set as paths — deviceIds are stored and echoed back in listings).
 * Returns null when clean.
 */
export function forbiddenDeviceIdResponse(deviceId: string): Response | null {
	return containsForbiddenChars(deviceId)
		? json(
				{ error: "deviceId contains characters that are not allowed" },
				{ status: 400 },
			)
		: null;
}
