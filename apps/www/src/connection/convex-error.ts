export type ConvexErrorKind =
	| { kind: "malformed-url" }
	| { kind: "network"; detail: string }
	| { kind: "missing-function"; functionName: string }
	| { kind: "validator"; functionName: string; detail: string }
	| { kind: "unknown"; detail: string };

export function categorizeError(err: unknown): ConvexErrorKind {
	if (err instanceof TypeError && /url/i.test(err.message)) {
		return { kind: "malformed-url" };
	}
	const message = err instanceof Error ? err.message : String(err);
	const lower = message.toLowerCase();

	if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
		return { kind: "network", detail: message };
	}

	const missingMatch = message.match(
		/could not find public function ['"]?([^'"\s]+)/i,
	);
	if (missingMatch) {
		return { kind: "missing-function", functionName: missingMatch[1] };
	}

	const validatorMatch = message.match(
		/validator error.*function ['"]?([^'"\s]+)/is,
	);
	if (validatorMatch) {
		return {
			kind: "validator",
			functionName: validatorMatch[1],
			detail: message,
		};
	}

	return { kind: "unknown", detail: message };
}

export function describeError(err: ConvexErrorKind): string {
	switch (err.kind) {
		case "malformed-url":
			return "That URL looks invalid. Try a full convex.cloud URL.";
		case "network":
			return "Couldn't reach this deployment. Check the URL and your connection.";
		case "missing-function":
			return `This deployment doesn't expose ${err.functionName}. It may not be running the mdly backend.`;
		case "validator":
			return `${err.functionName} rejected the call. The backend's function signature may differ from what this app expects.`;
		case "unknown":
			return err.detail;
	}
}
