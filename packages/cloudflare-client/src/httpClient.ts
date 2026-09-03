import type { z } from "zod/v4";
import {
	CloudflareResponseError,
	CloudflareValidationError,
} from "./errors.js";

/** Builds an absolute URL against `baseUrl`, skipping any `undefined` query param. */
export function buildUrl(
	baseUrl: string,
	path: string,
	params?: Record<string, string | undefined>,
): string {
	const url = new URL(path, baseUrl);
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) url.searchParams.set(key, value);
		}
	}
	return url.toString();
}

async function readErrorBody(
	response: Response,
): Promise<{ error?: string; code?: string }> {
	try {
		const body = (await response.json()) as { error?: unknown; code?: unknown };
		return {
			error: typeof body.error === "string" ? body.error : undefined,
			code: typeof body.code === "string" ? body.code : undefined,
		};
	} catch {
		return {};
	}
}

/**
 * Fetches `url`, validates a 2xx JSON body against `schema`, and throws a
 * clear, typed error otherwise (R9) — never returns unvalidated data, never
 * throws a bare/uninformative error for either failure mode:
 *  - non-2xx status -> `CloudflareResponseError` (carries the Worker's own
 *    `{error, code}` body when present, e.g. STORAGE_CAP_EXCEEDED, R7).
 *  - 2xx but invalid JSON or schema mismatch -> `CloudflareValidationError`.
 */
export async function requestJson<Schema extends z.ZodType>(
	url: string,
	init: RequestInit,
	schema: Schema,
	routeLabel: string,
): Promise<z.infer<Schema>> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (cause) {
		throw new CloudflareResponseError(
			`${routeLabel} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
			0,
		);
	}

	if (!response.ok) {
		const body = await readErrorBody(response);
		throw new CloudflareResponseError(
			body.error ?? `${routeLabel} failed with HTTP ${response.status}`,
			response.status,
			body.code,
		);
	}

	const text = await response.text();
	let json: unknown;
	try {
		json = text.length > 0 ? JSON.parse(text) : undefined;
	} catch (cause) {
		throw new CloudflareValidationError(
			`${routeLabel} returned a response that wasn't valid JSON`,
			cause,
		);
	}

	const parsed = schema.safeParse(json);
	if (!parsed.success) {
		throw new CloudflareValidationError(
			`${routeLabel} returned a response that doesn't match the expected shape: ${parsed.error.message}`,
			parsed.error.issues,
		);
	}
	return parsed.data;
}

export function jsonRequestInit(
	body: unknown,
	extraHeaders: Record<string, string>,
): RequestInit {
	return {
		method: "POST",
		headers: { "Content-Type": "application/json", ...extraHeaders },
		body: JSON.stringify(body),
	};
}
