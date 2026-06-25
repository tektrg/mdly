import { spawn } from "node:child_process";
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
	NotionSearchResult,
} from "../src/desktopApi/types";
import { notionMarkdownContentHash } from "../src/notion/contentHash";

const notionCommand = "ntn-acct";
const notionRequestTimeoutMs = 30_000;
const defaultNotionAccount = "7lab";
let selectedNotionAccount: string | null = null;

type CommandResult = {
	stdout: string;
	stderr: string;
};

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
): Promise<NotionPageUpdate> {
	const trimmedPageId = pageId.trim();
	if (!trimmedPageId) throw new Error("Notion page id is required.");
	const account = notionAccount(accountInput);

	await runNotionCommand(["pages", "update", trimmedPageId], {
		account,
		stdin: markdown,
	});
	return {
		pageId: trimmedPageId,
		account,
		contentHash: notionMarkdownContentHash(markdown),
	};
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
	return new Promise((resolve, reject) => {
		const account = notionAccount(options.account);
		const child = spawn(notionCommand, args, {
			env: {
				...process.env,
				NOTION_ACCOUNT: account,
			},
			stdio:
				options.stdin === undefined
					? ["ignore", "pipe", "pipe"]
					: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("Notion command timed out."));
		}, notionRequestTimeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		if (options.stdin !== undefined) {
			child.stdin.end(options.stdin);
		}
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(
				new Error(
					stderr.trim() ||
						`Notion command failed with exit code ${code ?? "unknown"}.`,
				),
			);
		});
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
