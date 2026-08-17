import { describe, expect, it } from "vitest";
import { objectPath, readObject, writeObject } from "./objectStore.js";
import {
	createFakeCompressor,
	createMemoryFileSystem,
} from "./testing/memoryFs.js";

const ROOT = "/ws/.mdly/history";

function deps() {
	return { fs: createMemoryFileSystem(), compressor: createFakeCompressor() };
}

describe("writeObject (R1)", () => {
	it("stores the same content twice as exactly one blob", async () => {
		const { fs, compressor } = deps();
		const content = new TextEncoder().encode("hello world");

		const first = await writeObject({ fs, compressor }, ROOT, content);
		const second = await writeObject({ fs, compressor }, ROOT, content);

		expect(first.hash).toBe(second.hash);
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(
			await fs.listDir(`${ROOT}/objects/${first.hash.slice(0, 2)}`),
		).toEqual([first.hash]);
	});

	it("never rewrites an existing blob, even after a different save in between (write-once)", async () => {
		const { fs, compressor } = deps();
		const contentA = new TextEncoder().encode("revision A");
		const contentB = new TextEncoder().encode(
			"a completely different revision B",
		);

		const a = await writeObject({ fs, compressor }, ROOT, contentA);
		const originalBytes = await fs.readFile(objectPath(ROOT, a.hash));

		await writeObject({ fs, compressor }, ROOT, contentB);
		await writeObject({ fs, compressor }, ROOT, contentA); // re-save matching A's hash again

		const bytesAfter = await fs.readFile(objectPath(ROOT, a.hash));
		expect(bytesAfter).toEqual(originalBytes);

		const readBack = await readObject({ fs, compressor }, ROOT, a.hash);
		expect(readBack).toEqual({ status: "ok", bytes: contentA });
	});

	it("lets two unrelated documents safely share one blob for identical content (QA5a)", async () => {
		const { fs, compressor } = deps();
		const shared = new TextEncoder().encode("shared body text");
		const documentAv1 = await writeObject({ fs, compressor }, ROOT, shared);
		const documentBv1 = await writeObject({ fs, compressor }, ROOT, shared);
		expect(documentAv1.hash).toBe(documentBv1.hash);

		// A moves on to different content...
		await writeObject(
			{ fs, compressor },
			ROOT,
			new TextEncoder().encode("A's new content"),
		);

		// ...but B's original blob is untouched.
		const bRead = await readObject({ fs, compressor }, ROOT, documentBv1.hash);
		expect(bRead).toEqual({ status: "ok", bytes: shared });
	});
});

describe("readObject (R28)", () => {
	it("surfaces a missing blob as 'unavailable', not a thrown error", async () => {
		const { fs, compressor } = deps();
		const result = await readObject(
			{ fs, compressor },
			ROOT,
			"0123456789abcdef",
		);
		expect(result).toEqual({ status: "unavailable" });
	});

	it("surfaces a cloud-sync placeholder (present but not actually downloaded) as 'unavailable' (QA1a)", async () => {
		const { fs, compressor } = deps();
		const hash = "abcdef0123456789";
		// Present in a directory listing, but its bytes are a placeholder that
		// fails to decompress — never the real gzip payload.
		fs.setRaw(objectPath(ROOT, hash), new Uint8Array([0, 0, 0]));

		expect(await fs.listDir(`${ROOT}/objects/${hash.slice(0, 2)}`)).toEqual([
			hash,
		]);
		const result = await readObject({ fs, compressor }, ROOT, hash);
		expect(result).toEqual({ status: "unavailable" });
	});

	it("an unavailable blob does not corrupt or skip a sibling, unrelated blob (QA5b)", async () => {
		const { fs, compressor } = deps();
		const good = await writeObject(
			{ fs, compressor },
			ROOT,
			new TextEncoder().encode("still readable"),
		);
		fs.setRaw(objectPath(ROOT, "deadbeefdeadbeef"), new Uint8Array([9, 9, 9]));

		const unavailable = await readObject(
			{ fs, compressor },
			ROOT,
			"deadbeefdeadbeef",
		);
		const stillGood = await readObject({ fs, compressor }, ROOT, good.hash);

		expect(unavailable).toEqual({ status: "unavailable" });
		expect(stillGood).toEqual({
			status: "ok",
			bytes: new TextEncoder().encode("still readable"),
		});
	});
});
