/**
 * The one file in this package allowed to import Node's real filesystem and
 * compression modules (R21). Exported only via the `@mdly/doc-history/node`
 * subpath so a non-Node consumer never accidentally pulls this in.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { Compressor, DocHistoryFileSystem } from "./fs.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

export function createNodeFileSystem(): DocHistoryFileSystem {
	return {
		async readFile(filePath) {
			try {
				return new Uint8Array(await fs.readFile(filePath));
			} catch (error) {
				if (isMissingPathError(error)) return null;
				throw error;
			}
		},
		async writeFile(filePath, data) {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, data);
		},
		async appendText(filePath, text) {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.appendFile(filePath, text, "utf8");
		},
		async exists(filePath) {
			try {
				await fs.access(filePath);
				return true;
			} catch {
				return false;
			}
		},
		async mkdirRecursive(dirPath) {
			await fs.mkdir(dirPath, { recursive: true });
		},
		async listDir(dirPath) {
			try {
				return await fs.readdir(dirPath);
			} catch (error) {
				if (isMissingPathError(error)) return [];
				throw error;
			}
		},
	};
}

export function createGzipCompressor(): Compressor {
	return {
		async compress(data) {
			return new Uint8Array(await gzipAsync(data));
		},
		async decompress(data) {
			return new Uint8Array(await gunzipAsync(data));
		},
	};
}
