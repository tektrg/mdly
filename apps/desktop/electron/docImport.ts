import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { extname } from "node:path";
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
): Promise<DocImportResult> {
	const commandPath = resolveAnyDocCommandPath();
	if (!commandPath) {
		throw docImportError("converter-missing");
	}

	const kind = formatKind(extname(filePath).toLowerCase());
	const title = fileTitle(filePath);

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