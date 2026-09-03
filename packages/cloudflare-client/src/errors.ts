/**
 * Error hierarchy for @mdly/cloudflare-client (R9).
 *
 * The whole point of validating every response with zod is that a malformed
 * or unexpected backend response must surface as a CLEAR sync error — never
 * crash the caller with an uncaught TypeError from reading an undefined
 * field, and never silently return corrupted/partial data as if it were
 * good. `CloudflareValidationError` is that clear error for the
 * zod-rejection case specifically; `CloudflareResponseError` is its sibling
 * for a well-formed-JSON-but-non-2xx response (e.g. the Worker's own typed
 * error codes like STORAGE_CAP_EXCEEDED, per charter R7).
 */

export class CloudflareClientError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "CloudflareClientError";
	}
}

/** The Worker answered, but with a non-2xx status. Carries whatever `{error, code}` shape it sent, if any. */
export class CloudflareResponseError extends CloudflareClientError {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code?: string,
	) {
		super(message);
		this.name = "CloudflareResponseError";
	}
}

/**
 * The Worker answered with a 2xx status, but the body didn't parse as JSON,
 * or didn't match the expected zod schema. This is the "malformed response"
 * case R9 requires to be caught explicitly rather than trusted.
 */
export class CloudflareValidationError extends CloudflareClientError {
	constructor(
		message: string,
		public readonly issues?: unknown,
	) {
		super(message);
		this.name = "CloudflareValidationError";
	}
}
