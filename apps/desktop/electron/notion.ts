import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	NotionConnectionStatus,
	NotionDatabaseQueryInput,
	NotionDatabaseQueryResult,
	NotionDatabaseRow,
	NotionObjectType,
	NotionPageMarkdown,
	NotionPageUpdate,
	NotionPageUpdateOptions,
	NotionSearchResult,
} from "../src/desktopApi/types";
import { notionMarkdownContentHash } from "../src/notion/contentHash";
import {
	commandPathEnv,
	type CommandResult,
	isExecutableFile,
	resolveCommandPath,
	runCommand,
} from "./externalCommand";

const notionCommand = "ntn-acct";
const notionCommandOverrideEnv = "HUBBLE_NOTION_COMMAND";
const commonNotionCommandDirs = ["/usr/local/bin", "/opt/homebrew/bin"];
const notionRequestTimeoutMs = 30_000;
const defaultNotionAccount = "7lab";
let selectedNotionAccount: string | null = null;

export function resolveNotionCommandPath({
	pathEnv = process.env.PATH,
	configuredCommand = process.env[notionCommandOverrideEnv],
	isExecutable = isExecutableFile,
}: {
	pathEnv?: string;
	configuredCommand?: string | null;
	isExecutable?: (filePath: string) => boolean;
} = {}): string | null {
	return resolveCommandPath({
		commandName: notionCommand,
		pathEnv,
		configuredCommand,
		commonDirs: commonNotionCommandDirs,
		isExecutable,
	});
}

export function notionCommandPathEnv(
	commandPath: string,
	pathEnv = process.env.PATH,
): string {
	return commandPathEnv(commandPath, commonNotionCommandDirs, pathEnv);
}

export async function getNotionConnectionStatus(
	accountInput?: string | null,
): Promise<NotionConnectionStatus> {
	const account = notionAccount(accountInput);
	const tokenKind = notionTokenKind(account);
	const status: NotionConnectionStatus = {
		account,
		availableAccounts: availableNotionAccounts(),
		tokenKind,
		connected: false,
		botName: null,
		error: null,
	};
	if (tokenKind === "missing") {
		return {
			...status,
			error: `No Notion token found for account "${account}".`,
		};
	}
	if (tokenKind !== "oauth") {
		return {
			...status,
			error: `OAuth token required for Notion Markdown sync on account "${account}".`,
		};
	}

	try {
		const { stdout } = await runNotionCommand(["api", "v1/users/me"], {
			account,
		});
		const parsed = readObject(JSON.parse(stdout) as unknown);
		return {
			...status,
			connected: true,
			botName: typeof parsed.name === "string" ? parsed.name : null,
		};
	} catch (error) {
		return {
			...status,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function setNotionAccount(
	accountInput: string,
): Promise<NotionConnectionStatus> {
	const account = accountInput.trim();
	if (!account) throw new Error("Notion account is required.");
	selectedNotionAccount = account;
	return getNotionConnectionStatus(account);
}

export async function searchNotion(
	query: string,
	accountInput?: string | null,
): Promise<NotionSearchResult[]> {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) return [];
	const account = notionAccount(accountInput);

	const payload = JSON.stringify({
		query: trimmedQuery,
		page_size: 10,
	});
	const { stdout } = await runNotionCommand(
		["api", "v1/search", "-d", payload],
		{ account },
	);
	return parseSearchResults(stdout, account);
}

export async function getNotionPageMarkdown(
	pageId: string,
	accountInput?: string | null,
): Promise<NotionPageMarkdown> {
	const trimmedPageId = pageId.trim();
	if (!trimmedPageId) throw new Error("Notion page id is required.");
	const account = notionAccount(accountInput);

	const { stdout } = await runNotionCommand(["pages", "get", trimmedPageId], {
		account,
	});
	const markdown = stdout.trimEnd();
	return {
		pageId: trimmedPageId,
		account,
		markdown,
		contentHash: notionMarkdownContentHash(markdown),
	};
}

export async function updateNotionPageMarkdown(
	pageId: string,
	markdown: string,
	accountInput?: string | null,
	options: NotionPageUpdateOptions = {},
): Promise<NotionPageUpdate> {
	const trimmedPageId = pageId.trim();
	if (!trimmedPageId) throw new Error("Notion page id is required.");
	const account = notionAccount(accountInput);
	const updatePayload = notionMarkdownUpdatePayload({
		previousMarkdown: options.previousMarkdown,
		currentMarkdown: options.currentMarkdown,
		nextMarkdown: markdown,
	});

	if (updatePayload.kind === "noop") {
		return {
			pageId: trimmedPageId,
			account,
			contentHash: notionMarkdownContentHash(updatePayload.markdown),
		};
	}

	if (updatePayload.kind === "targeted") {
		try {
			await runNotionCommand(
				[
					"api",
					`v1/pages/${trimmedPageId}/markdown`,
					"-X",
					"PATCH",
					"-d",
					JSON.stringify(notionMarkdownPatchBody(updatePayload)),
				],
				{ account },
			);
		} catch (error) {
			if (
				!shouldFallbackToFullNotionMarkdownUpdate(error, {
					previousMarkdown: options.previousMarkdown,
					currentMarkdown: options.currentMarkdown,
					nextMarkdown: markdown,
				})
			) {
				throw error;
			}
			await runNotionCommand(["pages", "update", trimmedPageId], {
				account,
				stdin: markdown,
			});
		}
	} else {
		await runNotionCommand(["pages", "update", trimmedPageId], {
			account,
			stdin: markdown,
		});
	}
	return {
		pageId: trimmedPageId,
		account,
		contentHash: notionMarkdownContentHash(markdown),
	};
}

export function shouldFallbackToFullNotionMarkdownUpdate(
	error: unknown,
	{
		previousMarkdown,
		currentMarkdown,
		nextMarkdown,
	}: {
		previousMarkdown?: string;
		currentMarkdown?: string;
		nextMarkdown: string;
	},
): boolean {
	const message = error instanceof Error ? error.message : String(error);
	if (!/\bNo matches found\b/i.test(message)) return false;
	return ![
		previousMarkdown ?? "",
		currentMarkdown ?? "",
		nextMarkdown,
	].some(hasVolatileNotionFileUrl);
}

type NotionMarkdownUpdatePayload =
	| { kind: "noop"; markdown: string }
	| { kind: "targeted"; oldStr: string; newStr: string }
	| { kind: "replace" };

export function notionMarkdownPatchBody(
	updatePayload: Extract<NotionMarkdownUpdatePayload, { kind: "targeted" }>,
) {
	return {
		type: "update_content",
		update_content: {
			content_updates: [
				{
					old_str: updatePayload.oldStr,
					new_str: updatePayload.newStr,
				},
			],
		},
	};
}

export function notionMarkdownUpdatePayload({
	previousMarkdown,
	currentMarkdown,
	nextMarkdown,
}: {
	previousMarkdown?: string;
	currentMarkdown?: string;
	nextMarkdown: string;
}): NotionMarkdownUpdatePayload {
	if (!previousMarkdown || !currentMarkdown) return { kind: "replace" };

	const nextWithCurrentFileUrls = replaceUnchangedVolatileNotionFileUrls({
		sourceMarkdown: nextMarkdown,
		previousMarkdown,
		currentMarkdown,
	});
	if (nextWithCurrentFileUrls === currentMarkdown) {
		return { kind: "noop", markdown: currentMarkdown };
	}

	const diff = uniqueReplacement(currentMarkdown, nextWithCurrentFileUrls);
	if (diff) {
		return { kind: "targeted", ...diff };
	}

	if (
		hasVolatileNotionFileUrl(previousMarkdown) ||
		hasVolatileNotionFileUrl(currentMarkdown) ||
		hasVolatileNotionFileUrl(nextMarkdown)
	) {
		throw new Error(
			"Cannot safely write back this Notion page because it contains Notion-hosted files with expiring URLs and a minimal targeted update could not be built.",
		);
	}

	return { kind: "replace" };
}

function replaceUnchangedVolatileNotionFileUrls({
	sourceMarkdown,
	previousMarkdown,
	currentMarkdown,
}: {
	sourceMarkdown: string;
	previousMarkdown: string;
	currentMarkdown: string;
}): string {
	const previousFiles = markdownFileReferences(previousMarkdown);
	const currentFiles = markdownFileReferences(currentMarkdown);
	let next = sourceMarkdown;
	for (let index = 0; index < previousFiles.length; index += 1) {
		const previous = previousFiles[index];
		const current = currentFiles[index];
		if (!previous || !current || previous.url === current.url) continue;
		const previousKey = volatileNotionImageUrlKey(previous.url);
		const currentKey = volatileNotionImageUrlKey(current.url);
		if (!previousKey || previousKey !== currentKey) continue;
		next = next.split(previous.url).join(current.url);
	}
	return next;
}

function uniqueReplacement(
	currentMarkdown: string,
	nextMarkdown: string,
): { oldStr: string; newStr: string } | null {
	const diff = changedRange(currentMarkdown, nextMarkdown);
	if (!diff) return null;

	for (const range of replacementRanges(currentMarkdown, nextMarkdown, diff)) {
		const oldStr = currentMarkdown.slice(range.currentStart, range.currentEnd);
		if (countOccurrences(currentMarkdown, oldStr) !== 1) continue;
		return {
			oldStr,
			newStr: nextMarkdown.slice(range.nextStart, range.nextEnd),
		};
	}

	return null;
}

function changedRange(
	currentMarkdown: string,
	nextMarkdown: string,
): {
	currentStart: number;
	currentEnd: number;
	nextStart: number;
	nextEnd: number;
} | null {
	let prefixLength = 0;
	while (
		prefixLength < currentMarkdown.length &&
		prefixLength < nextMarkdown.length &&
		currentMarkdown[prefixLength] === nextMarkdown[prefixLength]
	) {
		prefixLength += 1;
	}

	let suffixLength = 0;
	while (
		suffixLength < currentMarkdown.length - prefixLength &&
		suffixLength < nextMarkdown.length - prefixLength &&
		currentMarkdown[currentMarkdown.length - 1 - suffixLength] ===
			nextMarkdown[nextMarkdown.length - 1 - suffixLength]
	) {
		suffixLength += 1;
	}

	const currentEnd = currentMarkdown.length - suffixLength;
	if (prefixLength === currentEnd) return null;
	return {
		currentStart: prefixLength,
		currentEnd,
		nextStart: prefixLength,
		nextEnd: nextMarkdown.length - suffixLength,
	};
}

function replacementRanges(
	currentMarkdown: string,
	nextMarkdown: string,
	diff: {
		currentStart: number;
		currentEnd: number;
		nextStart: number;
		nextEnd: number;
	},
) {
	const ranges = [
		diff,
		lineBoundedRange(currentMarkdown, nextMarkdown, diff),
		{
			currentStart: 0,
			currentEnd: currentMarkdown.length,
			nextStart: 0,
			nextEnd: nextMarkdown.length,
		},
	];
	return ranges.filter(
		(range, index) =>
			ranges.findIndex(
				(candidate) =>
					candidate.currentStart === range.currentStart &&
					candidate.currentEnd === range.currentEnd &&
					candidate.nextStart === range.nextStart &&
					candidate.nextEnd === range.nextEnd,
			) === index,
	);
}

function lineBoundedRange(
	currentMarkdown: string,
	nextMarkdown: string,
	diff: {
		currentStart: number;
		currentEnd: number;
		nextStart: number;
		nextEnd: number;
	},
) {
	return {
		currentStart: lineStart(currentMarkdown, diff.currentStart),
		currentEnd: lineEnd(currentMarkdown, diff.currentEnd),
		nextStart: lineStart(nextMarkdown, diff.nextStart),
		nextEnd: lineEnd(nextMarkdown, diff.nextEnd),
	};
}

function lineStart(value: string, index: number): number {
	const previousLineBreak = value.lastIndexOf("\n", Math.max(0, index - 1));
	return previousLineBreak === -1 ? 0 : previousLineBreak + 1;
}

function lineEnd(value: string, index: number): number {
	const nextLineBreak = value.indexOf("\n", index);
	return nextLineBreak === -1 ? value.length : nextLineBreak;
}

function countOccurrences(value: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let index = 0;
	while (true) {
		const nextIndex = value.indexOf(needle, index);
		if (nextIndex === -1) return count;
		count += 1;
		index = nextIndex + needle.length;
	}
}

function markdownFileReferences(markdown: string): { url: string }[] {
	return [
		...markdownImageReferences(markdown),
		...htmlMediaReferences(markdown),
	];
}

function markdownImageReferences(markdown: string): { url: string }[] {
	return [...markdown.matchAll(/!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
		.map((match) => ({ url: match[1] ?? "" }))
		.filter((reference) => reference.url.length > 0);
}

function htmlMediaReferences(markdown: string): { url: string }[] {
	const references: { url: string }[] = [];
	const mediaTags = markdown.matchAll(/<(?:video|source)\b[^>]*>/gi);
	for (const tag of mediaTags) {
		const src = htmlAttributeValue(tag[0], "src");
		if (src) references.push({ url: src });
	}
	return references;
}

function htmlAttributeValue(tag: string, name: string): string | null {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = tag.match(
		new RegExp(
			`\\s${escapedName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
			"i",
		),
	);
	return match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
}

function hasVolatileNotionFileUrl(markdown: string): boolean {
	return markdownFileReferences(markdown).some((file) =>
		Boolean(volatileNotionImageUrlKey(file.url)),
	);
}

function volatileNotionImageUrlKey(rawUrl: string): string | null {
	try {
		const url = new URL(rawUrl);
		const host = url.hostname.toLowerCase();
		if (
			host === "prod-files-secure.s3.us-west-2.amazonaws.com" ||
			host.endsWith(".notion-static.com") ||
			host.endsWith(".notion.site")
		) {
			return `${url.origin}${url.pathname}`;
		}
	} catch {
		return null;
	}
	return null;
}

export async function queryNotionDatabase({
	sourceId,
	sourceObject,
	account: accountInput,
	startCursor,
	pageSize,
}: NotionDatabaseQueryInput): Promise<NotionDatabaseQueryResult> {
	const account = notionAccount(accountInput);
	const resolvedSourceId = await resolveDataSourceId(
		sourceId,
		sourceObject,
		account,
	);
	const limit = Math.min(Math.max(Math.trunc(pageSize ?? 25), 1), 100);
	const args = [
		"datasources",
		"query",
		resolvedSourceId,
		"--limit",
		String(limit),
		"--json",
	];
	if (startCursor) {
		args.push("--start-cursor", startCursor);
	}

	const { stdout } = await runNotionCommand(args, { account });
	const parsed = readObject(JSON.parse(stdout) as unknown);
	const results = Array.isArray(parsed.results) ? parsed.results : [];
	const rows = results.flatMap((row): NotionDatabaseRow[] => {
		const rowObject = readObject(row);
		const pageId = typeof rowObject.id === "string" ? rowObject.id : null;
		if (!pageId) return [];
		const properties = formatProperties(readObject(rowObject.properties));
		return [
			{
				pageId,
				title: titleForSearchResult(rowObject, "page"),
				url: typeof rowObject.url === "string" ? rowObject.url : null,
				lastEditedTime:
					typeof rowObject.last_edited_time === "string"
						? rowObject.last_edited_time
						: null,
				properties,
			},
		];
	});

	return {
		sourceId: resolvedSourceId,
		columns: databaseColumns(rows),
		rows,
		hasMore: parsed.has_more === true,
		nextCursor:
			typeof parsed.next_cursor === "string" ? parsed.next_cursor : null,
	};
}

async function resolveDataSourceId(
	sourceId: string,
	sourceObject: NotionDatabaseQueryInput["sourceObject"],
	account: string,
) {
	const trimmedSourceId = sourceId.trim();
	if (!trimmedSourceId) throw new Error("Notion data source id is required.");
	if (sourceObject === "data_source") return trimmedSourceId;

	const { stdout } = await runNotionCommand(
		["datasources", "resolve", trimmedSourceId, "--json"],
		{ account },
	);
	const parsed = readObject(JSON.parse(stdout) as unknown);
	const dataSources = Array.isArray(parsed.data_sources)
		? parsed.data_sources
		: Array.isArray(parsed.results)
			? parsed.results
			: [];
	const firstDataSource = readObject(dataSources[0]);
	const resolvedId =
		typeof firstDataSource.id === "string" ? firstDataSource.id : null;
	if (!resolvedId) {
		throw new Error("Notion database has no queryable data source.");
	}
	return resolvedId;
}

function notionAccount(accountInput?: string | null): string {
	return (
		accountInput?.trim() ||
		selectedNotionAccount ||
		process.env.NOTION_ACCOUNT?.trim() ||
		defaultNotionAccount
	);
}

function notionAccountsRoot(): string {
	return join(homedir(), ".config", "notion", "accounts");
}

function notionAccountPath(account: string): string {
	return join(notionAccountsRoot(), account);
}

function notionTokenKind(account: string): NotionConnectionStatus["tokenKind"] {
	const accountPath = notionAccountPath(account);
	if (existsSync(join(accountPath, "oauth_access_token"))) return "oauth";
	if (existsSync(join(accountPath, "api_key"))) return "api_key";
	return "missing";
}

function availableNotionAccounts(): string[] {
	const root = notionAccountsRoot();
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
}

function runNotionCommand(
	args: string[],
	options: { account?: string | null; stdin?: string } = {},
): Promise<CommandResult> {
	const account = notionAccount(options.account);
	const commandPath = resolveNotionCommandPath();
	if (!commandPath) {
		throw new Error(
			`Could not find ${notionCommand}. Install it or set ${notionCommandOverrideEnv} to its full path.`,
		);
	}
	return runCommand({
		commandPath,
		args,
		env: {
			NOTION_ACCOUNT: account,
			PATH: notionCommandPathEnv(commandPath),
		},
		stdin: options.stdin,
		timeoutMs: notionRequestTimeoutMs,
		commandLabel: "Notion",
	});
}

function parseSearchResults(
	raw: string,
	account: string,
): NotionSearchResult[] {
	const parsed = JSON.parse(raw) as unknown;
	const results = readObject(parsed).results;
	if (!Array.isArray(results)) return [];

	return results.flatMap((result): NotionSearchResult[] => {
		const object = readObject(result);
		const notionObject = object.object;
		if (!isNotionObjectType(notionObject)) return [];
		const id = typeof object.id === "string" ? object.id : null;
		if (!id) return [];
		return [
			{
				id,
				object: notionObject,
				account,
				title: titleForSearchResult(object, notionObject),
				url: typeof object.url === "string" ? object.url : null,
				lastEditedTime:
					typeof object.last_edited_time === "string"
						? object.last_edited_time
						: null,
			},
		];
	});
}

function isNotionObjectType(value: unknown): value is NotionObjectType {
	return value === "page" || value === "database" || value === "data_source";
}

function titleForSearchResult(
	result: Record<string, unknown>,
	object: NotionObjectType,
): string {
	if (object === "page") {
		const properties = readObject(result.properties);
		for (const property of Object.values(properties)) {
			const propertyObject = readObject(property);
			if (propertyObject.type !== "title") continue;
			const title = richTextPlainText(propertyObject.title);
			if (title) return title;
		}
	}

	const title = richTextPlainText(result.title);
	if (title) return title;
	return object === "page"
		? "Untitled Notion page"
		: "Untitled Notion database";
}

function richTextPlainText(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	const text = value
		.map((part) => {
			const object = readObject(part);
			return typeof object.plain_text === "string" ? object.plain_text : "";
		})
		.join("")
		.trim();
	return text || null;
}

function formatProperties(
	properties: Record<string, unknown>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(properties).map(([name, property]) => [
			name,
			formatPropertyValue(readObject(property)),
		]),
	);
}

function formatPropertyValue(property: Record<string, unknown>): string {
	const type = typeof property.type === "string" ? property.type : "";
	switch (type) {
		case "title":
		case "rich_text":
			return richTextPlainText(property[type]) ?? "";
		case "number":
			return property.number === null || property.number === undefined
				? ""
				: String(property.number);
		case "select":
		case "status":
			return optionName(property[type]);
		case "multi_select":
			return Array.isArray(property.multi_select)
				? property.multi_select.map(optionName).filter(Boolean).join(", ")
				: "";
		case "date":
			return formatDateProperty(property.date);
		case "checkbox":
			return property.checkbox === true ? "Yes" : "No";
		case "url":
		case "email":
		case "phone_number":
			return typeof property[type] === "string" ? property[type] : "";
		case "people":
			return Array.isArray(property.people)
				? property.people.map(personName).filter(Boolean).join(", ")
				: "";
		case "files":
			return Array.isArray(property.files)
				? property.files.map(fileName).filter(Boolean).join(", ")
				: "";
		case "relation":
			return Array.isArray(property.relation)
				? `${property.relation.length} relation${property.relation.length === 1 ? "" : "s"}`
				: "";
		case "formula":
			return formatPropertyValue(readObject(property.formula));
		case "rollup":
			return formatRollupProperty(readObject(property.rollup));
		case "created_time":
		case "last_edited_time":
			return typeof property[type] === "string" ? property[type] : "";
		case "created_by":
		case "last_edited_by":
			return personName(property[type]);
		case "unique_id":
			return formatUniqueId(readObject(property.unique_id));
		default:
			return "";
	}
}

function optionName(value: unknown): string {
	const option = readObject(value);
	return typeof option.name === "string" ? option.name : "";
}

function personName(value: unknown): string {
	const person = readObject(value);
	if (typeof person.name === "string") return person.name;
	if (typeof person.id === "string") return person.id;
	return "";
}

function fileName(value: unknown): string {
	const file = readObject(value);
	return typeof file.name === "string" ? file.name : "";
}

function formatDateProperty(value: unknown): string {
	const date = readObject(value);
	const start = typeof date.start === "string" ? date.start : "";
	const end = typeof date.end === "string" ? date.end : "";
	return end ? `${start} - ${end}` : start;
}

function formatRollupProperty(rollup: Record<string, unknown>): string {
	const rollupType = typeof rollup.type === "string" ? rollup.type : "";
	if (rollupType === "array" && Array.isArray(rollup.array)) {
		return rollup.array
			.map((value) => formatPropertyValue(readObject(value)))
			.filter(Boolean)
			.join(", ");
	}
	return formatPropertyValue({
		type: rollupType,
		[rollupType]: rollup[rollupType],
	});
}

function formatUniqueId(value: Record<string, unknown>): string {
	const prefix = typeof value.prefix === "string" ? value.prefix : "";
	const number =
		value.number === null || value.number === undefined
			? ""
			: String(value.number);
	return `${prefix}${number}`;
}

function databaseColumns(rows: NotionDatabaseRow[]): string[] {
	const columns: string[] = [];
	for (const row of rows) {
		for (const column of Object.keys(row.properties)) {
			if (!columns.includes(column)) columns.push(column);
		}
	}
	return columns;
}

function readObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
