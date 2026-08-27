import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repairOfficeZipBackslashes } from "./zipRepair";

/**
 * Builds a minimal, valid zip (one stored entry, no compression) so the repair
 * logic can be exercised against a real byte stream. CRCs are left zero — the
 * repair only reads/writes file-name fields, so CRC correctness is irrelevant.
 */
function buildZip(entryName: string, content: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(entryName);
	const dataBytes = new TextEncoder().encode(content);

	const local = new Uint8Array(30 + nameBytes.length);
	const localView = new DataView(local.buffer);
	localView.setUint32(0, 0x04034b50, true); // local file header signature
	localView.setUint16(4, 20, true); // version needed
	localView.setUint16(6, 0, true); // general purpose flag (no data descriptor)
	localView.setUint16(8, 0, true); // compression method (stored)
	localView.setUint32(18, dataBytes.length, true); // compressed size
	localView.setUint32(22, dataBytes.length, true); // uncompressed size
	localView.setUint16(26, nameBytes.length, true); // file name length
	localView.setUint16(28, 0, true); // extra field length
	local.set(nameBytes, 30);

	const central = new Uint8Array(46 + nameBytes.length);
	const centralView = new DataView(central.buffer);
	centralView.setUint32(0, 0x02014b50, true); // central directory signature
	centralView.setUint16(4, 20, true); // version made by
	centralView.setUint16(6, 20, true); // version needed
	centralView.setUint32(20, dataBytes.length, true); // compressed size
	centralView.setUint32(24, dataBytes.length, true); // uncompressed size
	centralView.setUint16(28, nameBytes.length, true); // file name length
	centralView.setUint16(30, 0, true); // extra field length
	centralView.setUint16(32, 0, true); // comment length
	centralView.setUint32(42, 0, true); // local header offset
	central.set(nameBytes, 46);

	const eocd = new Uint8Array(22);
	const eocdView = new DataView(eocd.buffer);
	eocdView.setUint32(0, 0x06054b50, true); // end of central directory signature
	eocdView.setUint16(8, 1, true); // entries on this disk
	eocdView.setUint16(10, 1, true); // total entries
	eocdView.setUint32(12, central.length, true); // central directory size
	eocdView.setUint32(16, local.length + dataBytes.length, true); // cd offset

	const total = local.length + dataBytes.length + central.length + eocd.length;
	const out = new Uint8Array(total);
	out.set(local, 0);
	out.set(dataBytes, local.length);
	out.set(central, local.length + dataBytes.length);
	out.set(eocd, local.length + dataBytes.length + central.length);
	return out;
}

describe("repairOfficeZipBackslashes", () => {
	it("returns null for non-Office files", async () => {
		expect(await repairOfficeZipBackslashes("/tmp/notes.txt")).toBeNull();
		expect(await repairOfficeZipBackslashes("/tmp/notes.md")).toBeNull();
	});

	it("returns null for files that do not exist", async () => {
		expect(
			await repairOfficeZipBackslashes("/tmp/does-not-exist.docx"),
		).toBeNull();
	});

	it("rewrites backslash entry names to forward slashes", async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), "hubble-ziprepair-"));
		const filePath = join(dir, "broken.docx");
		await fs.writeFile(filePath, buildZip("word\\document.xml", "<w/>"));

		const repairedPath = await repairOfficeZipBackslashes(filePath);
		expect(repairedPath).not.toBeNull();

		const repaired = new TextDecoder().decode(await fs.readFile(repairedPath!));
		expect(repaired).toContain("word/document.xml");
		expect(repaired).not.toContain("word\\document.xml");
	});

	it("leaves a forward-slash zip untouched", async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), "hubble-ziprepair-"));
		const filePath = join(dir, "plain.docx");
		await fs.writeFile(filePath, buildZip("word/document.xml", "<w/>"));

		expect(await repairOfficeZipBackslashes(filePath)).toBeNull();
	});
});
