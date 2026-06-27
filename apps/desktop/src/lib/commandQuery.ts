export type CommandScopeKind = "folder" | "notion" | "workspace";

export type ScopeTrigger = {
	start: number;
	end: number;
	filter: string;
};

export type FolderScopeOption = {
	path: string;
	label: string;
	relativePath: string;
};

export type ResolvedFolderScope = {
	folder: FolderScopeOption;
	searchQuery: string;
};

export type FolderScopeState =
	| { kind: "none"; searchQuery: string }
	| { kind: "editing"; input: string; searchQuery: string }
	| ({ kind: "resolved" } & ResolvedFolderScope);

export type NotionScopeState =
	| { kind: "none" }
	| {
			kind: "needs-account";
			input: string;
			accounts: string[];
			searchQuery: string;
	  }
	| {
			kind: "invalid-account";
			input: string;
			accounts: string[];
			searchQuery: string;
	  }
	| { kind: "ready"; account: string | null; searchQuery: string };

export type WorkspaceScopeState =
	| { kind: "none" }
	| { kind: "active"; searchQuery: string };

const folderScopePrefix = "@folder:";
const notionScopePrefix = "@notion";
const workspaceScopePrefix = "@workspace";

export const commandScopeOptions: {
	kind: CommandScopeKind;
	label: string;
	description: string;
}[] = [
	{
		kind: "folder",
		label: "folder",
		description: "Search Markdown files inside one folder",
	},
	{
		kind: "notion",
		label: "notion",
		description: "Search pages and databases in a Notion account",
	},
	{
		kind: "workspace",
		label: "workspace",
		description: "Switch to a recent workspace or add a folder",
	},
];

export function findScopeTrigger(query: string): ScopeTrigger | null {
	const tokenStart = Math.max(query.lastIndexOf(" "), query.lastIndexOf("\t")) + 1;
	const token = query.slice(tokenStart);
	if (!/^@[a-z]*$/i.test(token)) return null;
	return {
		start: tokenStart,
		end: query.length,
		filter: token.slice(1).toLocaleLowerCase(),
	};
}

export function insertScopeToken(
	query: string,
	trigger: ScopeTrigger | null,
	scope: CommandScopeKind,
) {
	const replacement =
		scope === "notion" ? "@notion " : scope === "workspace" ? "@workspace " : "@folder:";
	if (!trigger) return `${query}${query && !/\s$/.test(query) ? " " : ""}${replacement}`;
	return `${query.slice(0, trigger.start)}${replacement}${query.slice(trigger.end)}`;
}

export function resolveFolderScope(
	query: string,
	folders: FolderScopeOption[],
): FolderScopeState {
	const scopeStart = query.lastIndexOf(folderScopePrefix);
	if (scopeStart < 0) return { kind: "none", searchQuery: query.trim() };

	const beforeScope = query.slice(0, scopeStart).trim();
	const scopeValueStart = scopeStart + folderScopePrefix.length;
	const scopeInput = query.slice(scopeValueStart);
	const match = findExactFolderMatch(scopeInput, folders);
	if (!match) {
		return {
			kind: "editing",
			input: scopeInput.trimStart(),
			searchQuery: beforeScope,
		};
	}

	return {
		kind: "resolved",
		folder: match.folder,
		searchQuery: joinQueryParts(beforeScope, match.remainingQuery),
	};
}

export function resolveNotionScope(
	query: string,
	availableAccounts: string[],
): NotionScopeState {
	const scopeStart = query.lastIndexOf(notionScopePrefix);
	if (scopeStart < 0) return { kind: "none" };

	const beforeScope = query.slice(0, scopeStart).trim();
	const afterScope = query.slice(scopeStart + notionScopePrefix.length);
	const multipleAccounts = availableAccounts.length > 1;

	if (afterScope.startsWith(":")) {
		const accountInput = afterScope.slice(1).split(/\s/, 1)[0] ?? "";
		const remainingQuery = afterScope.slice(1 + accountInput.length).trim();
		if (!accountInput && multipleAccounts) {
			return {
				kind: "needs-account",
				input: "",
				accounts: availableAccounts,
				searchQuery: joinQueryParts(beforeScope, remainingQuery),
			};
		}
		if (
			accountInput &&
			availableAccounts.length > 0 &&
			!availableAccounts.includes(accountInput)
		) {
			return {
				kind: "invalid-account",
				input: accountInput,
				accounts: availableAccounts,
				searchQuery: joinQueryParts(beforeScope, remainingQuery),
			};
		}
		return {
			kind: "ready",
			account: accountInput || availableAccounts[0] || null,
			searchQuery: joinQueryParts(beforeScope, remainingQuery),
		};
	}

	const remainingQuery = afterScope.trim();
	if (multipleAccounts) {
		return {
			kind: "needs-account",
			input: "",
			accounts: availableAccounts,
			searchQuery: joinQueryParts(beforeScope, remainingQuery),
		};
	}

	return {
		kind: "ready",
		account: availableAccounts[0] || null,
		searchQuery: joinQueryParts(beforeScope, remainingQuery),
	};
}

export function resolveWorkspaceScope(query: string): WorkspaceScopeState {
	const scopeStart = query.lastIndexOf(workspaceScopePrefix);
	if (scopeStart < 0) return { kind: "none" };

	const beforeScope = query.slice(0, scopeStart).trim();
	const afterScope = query.slice(scopeStart + workspaceScopePrefix.length).trim();
	return {
		kind: "active",
		searchQuery: joinQueryParts(beforeScope, afterScope),
	};
}

function findExactFolderMatch(input: string, folders: FolderScopeOption[]) {
	const normalizedInput = normalizeScopeValue(input);
	const sortedFolders = [...folders].sort(
		(left, right) => right.relativePath.length - left.relativePath.length,
	);
	const labelCounts = new Map<string, number>();
	for (const folder of folders) {
		const label = normalizeScopeValue(folder.label);
		labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
	}

	for (const folder of sortedFolders) {
		const normalizedLabel = normalizeScopeValue(folder.label);
		const normalizedRelativePath = normalizeScopeValue(folder.relativePath);
		const labelIsDuplicate = (labelCounts.get(normalizedLabel) ?? 0) > 1;
		const values =
			labelIsDuplicate && normalizedRelativePath === normalizedLabel
				? []
				: [folder.relativePath];
		if (!labelIsDuplicate) {
			values.push(folder.label);
		}
		for (const value of values) {
			const normalizedValue = normalizeScopeValue(value);
			if (
				normalizedInput === normalizedValue ||
				normalizedInput.startsWith(`${normalizedValue} `)
			) {
				return {
					folder,
					remainingQuery: input.slice(value.length).trim(),
				};
			}
		}
	}

	return null;
}

function normalizeScopeValue(value: string) {
	return value.trim().toLocaleLowerCase();
}

function joinQueryParts(...parts: string[]) {
	return parts
		.map((part) => part.trim())
		.filter(Boolean)
		.join(" ");
}
