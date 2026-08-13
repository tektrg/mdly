import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";

const officeZipExtensions = new Set([".docx", ".pptx", ".xlsx"]);

/**
 * SharePoint/Word-Online .docx files use backslash separators in their zip
 * entry names, which breaks standard zip readers. Repair rewrites those
 * entries to use forward slashes so `anydoc` can read them.
 *
 * Returns the path to the repaired file, or null if no repair was needed.
 */
export async function repairOfficeZipBackslashes(
	filePath: string,
): Promise<string | null> {
	const ext = extname(filePath).toLowerCase();
	if (!officeZipExtensions.has(ext)) return null;

	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await fs.readFile(filePath));
	} catch {
		return null;
	}

	const needsRepair = hasBackslashEntries(bytes);
	if (!needsRepair) return null;

	const repaired = rewriteBackslashEntries(bytes);
	if (!repaired) return null;

	const tmpDir = join(tmpdir(), "hubble-doc-repair");
	await fs.mkdir(tmpDir, { recursive: true });
	const stem = filePath.split(/[\\/]/).pop() ?? "document";
	const dot = stem.lastIndexOf(".");
	const baseName = dot > 0 ? stem.slice(0, dot) : stem;
	const repairedPath = join(tmpDir, `${baseName}-${randomUUID().slice(0, 8)}${ext}`);

	await fs.writeFile(repairedPath, repaired);
	return repairedPath;
}

/**
 * Detect whether a zip archive contains entries with backslash separators.
 * Scans the central directory for file name fields containing backslashes.
 */
function hasBackslashEntries(bytes: Uint8Array): boolean {
	if (!isZip(bytes)) return false;

	// Find the end of central directory record
	const eocdOffset = findEocd(bytes);
	if (eocdOffset === -1) return false;

	// Read central directory offset and size from EOCD
	const cdOffset = readUint32LE(bytes, eocdOffset + 16);
	const cdSize = readUint32LE(bytes, eocdOffset + 12);

	if (cdOffset + cdSize > bytes.length) return false;

	// Scan central directory entries for backslash file names
	let offset = cdOffset;
	while (offset < cdOffset + cdSize) {
		const signature = readUint32LE(bytes, offset);
		if (signature !== 0x02014b50) break;

		const fileNameLength = readUint16LE(bytes, offset + 28);
		const extraFieldLength = readUint16LE(bytes, offset + 30);
		const commentLength = readUint16LE(bytes, offset + 32);

		const fileNameStart = offset + 46;
		const fileNameBytes = bytes.subarray(
			fileNameStart,
			fileNameStart + fileNameLength,
		);
		const fileName = new TextDecoder().decode(fileNameBytes);

		if (fileName.includes("\\")) return true;

		offset += 46 + fileNameLength + extraFieldLength + commentLength;
	}

	return false;
}

/**
 * Rewrite backslash entry names to forward slashes in a zip archive.
 * This is a targeted repair: it only fixes the file name fields in local
 * file headers and central directory entries. Other data is unchanged.
 */
function rewriteBackslashEntries(bytes: Uint8Array): Uint8Array | null {
	if (!isZip(bytes)) return null;

	const eocdOffset = findEocd(bytes);
	if (eocdOffset === -1) return null;

	const cdOffset = readUint32LE(bytes, eocdOffset + 16);
	const cdSize = readUint32LE(bytes, eocdOffset + 12);

	if (cdOffset + cdSize > bytes.length) return null;

	// Build a map of backslash → forward slash replacements for file names
	const replacements = new Map<number, Uint8Array>();

	// Scan local file headers
	let offset = 0;
	while (offset < bytes.length - 30) {
		const signature = readUint32LE(bytes, offset);
		if (signature === 0x02014b50) break; // central directory starts
		if (signature !== 0x04034b50) break; // not a local file header

		const compressedSize = readUint32LE(bytes, offset + 18);
		const fileNameLength = readUint16LE(bytes, offset + 26);
		const extraFieldLength = readUint16LE(bytes, offset + 28);

		const fileNameStart = offset + 30;
		const fileNameBytes = bytes.subarray(
			fileNameStart,
			fileNameStart + fileNameLength,
		);
		const fileName = new TextDecoder().decode(fileNameBytes);

		if (fileName.includes("\\")) {
			const fixed = new TextEncoder().encode(fileName.replace(/\\/g, "/"));
			replacements.set(fileNameStart, fixed);
		}

		// Advance past the header, extra field, and the file's compressed data.
		offset += 30 + fileNameLength + extraFieldLength + compressedSize;
	}

	// Also scan and fix central directory entries
	let cdPos = cdOffset;
	while (cdPos < cdOffset + cdSize) {
		const signature = readUint32LE(bytes, cdPos);
		if (signature !== 0x02014b50) break;

		const fileNameLength = readUint16LE(bytes, cdPos + 28);
		const extraFieldLength = readUint16LE(bytes, cdPos + 30);
		const commentLength = readUint16LE(bytes, cdPos + 32);

		const fileNameStart = cdPos + 46;
		const fileNameBytes = bytes.subarray(
			fileNameStart,
			fileNameStart + fileNameLength,
		);
		const fileName = new TextDecoder().decode(fileNameBytes);

		if (fileName.includes("\\")) {
			const fixed = new TextEncoder().encode(fileName.replace(/\\/g, "/"));
			replacements.set(fileNameStart, fixed);
		}

		cdPos += 46 + fileNameLength + extraFieldLength + commentLength;
	}

	if (replacements.size === 0) return null;

	// Build the repaired archive by splicing in fixed file names
	const result = new Uint8Array(bytes.length);
	let writePos = 0;
	let readPos = 0;

	// Sort replacements by position
	const sortedRepairs = [...replacements.entries()].sort(
		([a], [b]) => a - b,
	);

	for (const [repairPos, repairBytes] of sortedRepairs) {
		// Copy bytes before this repair point
		const copyLen = repairPos - readPos;
		result.set(bytes.subarray(readPos, repairPos), writePos);
		writePos += copyLen;
		readPos = repairPos;

		// Write the repaired bytes
		result.set(repairBytes, writePos);
		writePos += repairBytes.length;

		// Skip the original bytes (they're the same length since we only replace \\ with /)
		readPos += repairBytes.length;
	}

	// Copy remaining bytes
	const remaining = bytes.length - readPos;
	result.set(bytes.subarray(readPos), writePos);
	writePos += remaining;

	return result.subarray(0, writePos);
}

function isZip(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x50 &&
		bytes[1] === 0x4b
	);
}

function findEocd(bytes: Uint8Array): number {
	// Search backwards from the end for the EOCD signature
	const maxSearch = Math.min(bytes.length, 65535 + 22);
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - maxSearch); i--) {
		if (
			bytes[i] === 0x50 &&
			bytes[i + 1] === 0x4b &&
			bytes[i + 2] === 0x05 &&
			bytes[i + 3] === 0x06
		) {
			return i;
		}
	}
	return -1;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
	return (
		bytes[offset] +
		(bytes[offset + 1] << 8) +
		(bytes[offset + 2] << 16) +
		(bytes[offset + 3] << 24)
	);
}