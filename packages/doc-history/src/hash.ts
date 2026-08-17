/**
 * Isomorphic SHA-256 content hashing via the Web Crypto API (works in Node 20+
 * and every browser) — copied from `packages/sync`'s proven `contentHash`
 * pattern rather than `apps/desktop/electron/main.ts`'s own Node-only hashing
 * (which exists there for the unrelated pasted-image feature).
 */
export async function contentHash(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export function textToBytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}
