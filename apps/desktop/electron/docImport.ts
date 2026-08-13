import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type {
	ConverterStatus,
	DocImportErrorKind,
	DocImportResult,
} from "../src/desktopApi/types";
import {
	commandPathEnv,
	isExecutableFile,
	resolveCommandPath,
	runCommand,
} from "./externalCommand";
import { repairOfficeZipBackslashes } from "./zipRepair";

const anydocCommand = "anydoc";
const anydocCommandOverrideEnv = "HUBBLE_ANYDOC_COMMAND";
const commonAnyDocCommandDirs = ["/usr/local/bin", "/opt/homebrew/bin"];
const anydocRequestTimeoutMs = 60_000;
const acquireTimeoutMs = 30_000;

export type DocImportError = {
	kind: DocImportErrorKind;
	message: string;
};

export function resolveAnyDocCommandPath({
	pathEnv = process.env.PATH,
	configuredCommand = process.env[anydocCommandOverrideEnv],
	isExecutable = isExecutableFile,
}: {
	pathEnv?: string;
	configuredCommand?: string | null;
	isExecutable?: (filePath: string) => boolean;
} = {}): string | null {
	return resolveCommandPath({
		commandName: anydocCommand,
		pathEnv,
		configuredCommand,
		commonDirs: commonAnyDocCommandDirs,
		isExecutable,
	});
}

export function anydocCommandPathEnv(
	commandPath: string,
	pathEnv = process.env.PATH,
): string {
	return commandPathEnv(commandPath, commonAnyDocCommandDirs, pathEnv);
}

export async function checkConverterStatus(): Promise<ConverterStatus> {
	const commandPath = resolveAnyDocCommandPath();
	if (!commandPath) {
		return {
			available: false,
			version: null,
			installHint: "Install anydoc: npm install -g anydoc",
		};
	}

	try {
		const { stdout } = await runCommand({
			commandPath,
			args: ["--version"],
			timeoutMs: 10_000,
			commandLabel: "anydoc",
		});
		return {
			available: true,
			version: stdout.trim() || null,
			installHint: "",
		};
	} catch {
		return {
			available: true,
			version: null,
			installHint: "",
		};
	}
}

export async function convertDocFile(
	filePath: string,
	options?: { title?: string },
): Promise<DocImportResult> {
	const commandPath = resolveAnyDocCommandPath();
	if (!commandPath) {
		throw docImportError("converter-missing");
	}

	const kind = formatKind(extname(filePath).toLowerCase());
	const title = options?.title ?? fileTitle(filePath);

	// Repair SharePoint zip archives with backslash entry names before conversion.
	const repairedPath = await repairOfficeZipBackslashes(filePath);
	const convertPath = repairedPath ?? filePath;

	try {
		const { stdout } = await runCommand({
			commandPath,
			args: [convertPath],
			env: { PATH: anydocCommandPathEnv(commandPath) },
			timeoutMs: anydocRequestTimeoutMs,
			commandLabel: "anydoc",
		});

		// Clean up the repaired temp file after conversion.
		if (repairedPath) {
			await cleanupRepairedFile(repairedPath);
		}
		const markdown = stdout.trimEnd();
		return {
			markdown,
			contentHash: docMarkdownContentHash(markdown),
			title,
			kind,
		};
	} catch (error) {
		if (repairedPath) await cleanupRepairedFile(repairedPath);
		throw mapDocImportError(error);
	}
}

async function cleanupRepairedFile(filePath: string): Promise<void> {
	try {
		await fs.unlink(filePath);
	} catch {
		// Best-effort cleanup; a leftover temp file is harmless.
	}
}

export type AcquiredSource = {
	path: string;
	title: string;
	kind: string;
	url: string;
};

/**
 * Download a document URL (e.g. a SharePoint anonymous share link) to a local
 * temp file, following redirects. Detects login-walled responses and returns a
 * typed error so the UI can give a clear manual workaround instead of failing
 * silently.
 */
export async function acquireDocSource(
	url: string,
): Promise<AcquiredSource> {
	const parsedUrl = new URL(url);
	if (!/^https?:$/.test(parsedUrl.protocol)) {
		throw docImportError("unsupported-format");
	}

	let response: Response;
	try {
		response = await fetch(url, {
			redirect: "follow",
			headers: {
				accept:
					"application/octet-stream, application/pdf, application/zip, */*",
			},
			signal: AbortSignal.timeout(acquireTimeoutMs),
		});
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			throw docImportError("timeout");
		}
		throw Object.assign(
			new Error("Could not download the document from this URL."),
			{ kind: "unknown" as DocImportErrorKind },
		);
	}

	if (isLoginWall(response)) {
		throw Object.assign(
			new Error(
				"This link requires a login. Download the file manually, then import it from your computer.",
			),
			{ kind: "unsupported-format" as DocImportErrorKind },
		);
	}

	if (!response.ok) {
		throw Object.assign(
			new Error(`Download failed with status ${response.status}.`),
			{ kind: "unknown" as DocImportErrorKind },
		);
	}

	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0) {
		throw docImportError("unreadable");
	}

	const ext = extFromUrl(url, response.headers.get("content-type"));
	const title = titleFromUrl(url, ext);
	const tmpDir = join(tmpdir(), "hubble-doc-acquire");
	await fs.mkdir(tmpDir, { recursive: true });
	const acquiredPath = join(tmpDir, `${randomUUID()}${ext}`);
	await fs.writeFile(acquiredPath, bytes);

	return {
		path: acquiredPath,
		title,
		kind: formatKind(ext),
		url,
	};
}

function isLoginWall(response: Response): boolean {
	const status = response.status;
	if (status === 401 || status === 403) return true;

	const url = response.url ?? "";
	if (
		/login\.microsoftonline\.com/i.test(url) ||
		/login\.live\.com/i.test(url) ||
		/accounts\.google\.com\/servicelogin/i.test(url)
	) {
		return true;
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("text/html")) {
		// A login page is HTML that is not a document. We cannot read the body
		// twice here, so rely on the redirect host or status as the signal.
		return false;
	}

	return false;
}

function extFromUrl(url: string, contentType: string | null): string {
	const fromContentType = extFromContentType(contentType);
	if (fromContentType) return fromContentType;

	const fromPath = extname(new URL(url).pathname).toLowerCase();
	if (fromPath) return fromPath;

	return ".docx";
}

function extFromContentType(contentType: string | null): string | null {
	const mime = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
	switch (mime) {
		case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		case "application/msword":
			return ".docx";
		case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
			return ".pptx";
		case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
			return ".xlsx";
		case "application/pdf":
			return ".pdf";
		case "text/csv":
			return ".csv";
		default:
			return null;
	}
}

function titleFromUrl(url: string, ext: string): string {
	const pathname = new URL(url).pathname;
	const name = basename(pathname) || "document";
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const decoded = decodeURIComponent(stem).trim();
	return decoded || "document";
}

export function docMarkdownContentHash(markdown: string): string {
	return createHash("sha256").update(markdown).digest("hex");
}

function mapDocImportError(error: unknown): DocImportError & Error {
	const message = error instanceof Error ? error.message : String(error);

	if (/timed out/i.test(message)) {
		return Object.assign(
			new Error("Document conversion timed out. The file may be too large."),
			{ kind: "timeout" as DocImportErrorKind },
		);
	}

	if (/cannot find|command not found|ENOENT/i.test(message)) {
		return Object.assign(new Error(message), {
			kind: "converter-missing" as DocImportErrorKind,
		});
	}

	if (/unsupported|not supported|cannot read|unreadable/i.test(message)) {
		if (/scanned|ocr|image.?only|no text/i.test(message)) {
			return Object.assign(
				new Error(
					"This PDF is a scanned document (pictures of text). It cannot be converted because it contains no machine-readable text.",
				),
				{ kind: "scanned-pdf" as DocImportErrorKind },
			);
		}
		return Object.assign(new Error(message), {
			kind: "unreadable" as DocImportErrorKind,
		});
	}

	return Object.assign(new Error(message), {
		kind: "unknown" as DocImportErrorKind,
	});
}

function docImportError(
	kind: DocImportErrorKind,
): DocImportError & Error {
	const messages: Record<DocImportErrorKind, string> = {
		"converter-missing":
			"Could not find anydoc. Install it: npm install -g anydoc",
		unreadable: "The document could not be read.",
		"scanned-pdf":
			"This PDF is a scanned document (pictures of text). It cannot be converted because it contains no machine-readable text.",
		"unsupported-format": "This document format is not supported.",
		timeout: "Document conversion timed out.",
		unknown: "An unknown error occurred during document conversion.",
	};
	return Object.assign(new Error(messages[kind]), { kind });
}

function formatKind(ext: string): string {
	switch (ext) {
		case ".docx":
			return "docx";
		case ".pptx":
			return "pptx";
		case ".xlsx":
			return "xlsx";
		case ".csv":
			return "csv";
		case ".pdf":
			return "pdf";
		case ".doc":
			return "doc";
		case ".odt":
			return "odt";
		default:
			return ext.replace(/^\./, "");
	}
}

function fileTitle(filePath: string): string {
	const name = filePath.split(/[\\/]/).pop() ?? filePath;
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(0, dot) : name;
}