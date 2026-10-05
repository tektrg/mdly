/**
 * "Files in scope" — the ONE rules module deciding which workspace files the
 * app shows ("In app") and which Cloud Sync uploads ("Synced"). Every
 * consumer (sidebar listing, sync walk, sync watcher, CLI watcher, Settings)
 * derives its exclusion list from here, so the lists cannot drift.
 *
 * Invariant: synced ⊆ in app. A rule with `inApp: false` is never synced.
 *
 * Patterns follow the shared exclusion convention (`isExcludedByEntries`):
 * a bare name matches at any depth, a path (`fe/docs`) or leading slash
 * (`/dist`) is anchored to the workspace root, and glob characters
 * (`*.log`) use gitignore matching.
 */

export type FilesScopeRule = {
	pattern: string;
	inApp: boolean;
	synced: boolean;
};

export type FilesScope = {
	/** Hide files matched by `.gitignore`/`.ignore` from the app. Sync always honors them. */
	respectGitignore: boolean;
	rules: FilesScopeRule[];
};

/** Locked rows: never shown, never synced. Not stored in a workspace's rules. */
export const BUILT_IN_HIDDEN_PATTERNS: readonly string[] = [
	".git",
	"node_modules",
	"dist",
	".dev-electron",
	".hubble",
	".mdly",
	"*.assets",
];

/** Dependency/agent/build folders: visible in the app, kept out of sync (watch-budget pruning — see cloudSyncWiring quit-hang notes). */
export const DEFAULT_SYNC_ONLY_EXCLUDED_PATTERNS: readonly string[] = [
	".claude",
	"Pods",
	"build",
	"DerivedData",
	".expo",
	"vendor",
	".venv",
	"target",
	".next",
];

/** Extensions Cloud Sync uploads as notes. */
export const SYNCED_NOTE_EXTENSION_RE = /\.(md|markdown|mdown)$/i;

export const BUILT_IN_DEFAULT_FILES_SCOPE: FilesScope = {
	respectGitignore: true,
	rules: DEFAULT_SYNC_ONLY_EXCLUDED_PATTERNS.map((pattern) => ({
		pattern,
		inApp: true,
		synced: false,
	})),
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBuiltInPattern(pattern: string): boolean {
	return BUILT_IN_HIDDEN_PATTERNS.includes(pattern.replace(/^\/+|\/+$/g, ""));
}

/** Trims, drops blanks/built-ins/duplicates, and enforces synced ⊆ in app. */
export function normalizeFilesScopeRules(
	rules: readonly FilesScopeRule[],
): FilesScopeRule[] {
	const seen = new Set<string>();
	const normalized: FilesScopeRule[] = [];
	for (const rule of rules) {
		const pattern = rule.pattern.trim().replace(/\\/g, "/");
		if (pattern === "" || isBuiltInPattern(pattern) || seen.has(pattern))
			continue;
		seen.add(pattern);
		normalized.push({
			pattern,
			inApp: rule.inApp,
			synced: rule.inApp && rule.synced,
		});
	}
	return normalized;
}

/** Parses an untrusted `scope` value (config file / IPC); `null` when it is not a usable scope. */
export function parseFilesScope(raw: unknown): FilesScope | null {
	if (!isRecord(raw) || !Array.isArray(raw.rules)) return null;
	const rules: FilesScopeRule[] = [];
	for (const candidate of raw.rules) {
		if (!isRecord(candidate) || typeof candidate.pattern !== "string") continue;
		rules.push({
			pattern: candidate.pattern,
			inApp: candidate.inApp !== false,
			synced: candidate.synced === true,
		});
	}
	return {
		respectGitignore: raw.respectGitignore !== false,
		rules: normalizeFilesScopeRules(rules),
	};
}

/** Migration: a legacy `cloudSync.excludedFolders` list becomes rows In app ✓ / Synced ✗, so the sidebar does not change. */
export function filesScopeFromLegacyExcludedFolders(
	excludedFolders: readonly string[],
	respectGitignore: boolean,
): FilesScope {
	return {
		respectGitignore,
		rules: normalizeFilesScopeRules(
			excludedFolders.map((pattern) => ({
				pattern,
				inApp: true,
				synced: false,
			})),
		),
	};
}

/** The parts of `.hubble/config.json` that decide a workspace's scope. */
export type FilesScopeConfigSource = {
	scope?: unknown;
	cloudSync?: { excludedFolders?: readonly string[] } | null;
};

/**
 * The workspace's effective scope: its own `scope` section, else a migration
 * of the legacy sync exclusion list, else the global default list.
 */
export function resolveWorkspaceFilesScope(
	config: FilesScopeConfigSource | null | undefined,
	defaults: FilesScope = BUILT_IN_DEFAULT_FILES_SCOPE,
): FilesScope {
	const own = parseFilesScope(config?.scope);
	if (own) return own;
	const legacy = config?.cloudSync?.excludedFolders;
	if (legacy)
		return filesScopeFromLegacyExcludedFolders(
			legacy,
			defaults.respectGitignore,
		);
	return {
		respectGitignore: defaults.respectGitignore,
		rules: normalizeFilesScopeRules(defaults.rules),
	};
}

/** Exclusion entries for what the app lists (sidebar, document table, Cmd+P). Built-ins are applied by the walker itself. */
export function appExcludedEntries(scope: FilesScope): string[] {
	return scope.rules.filter((rule) => !rule.inApp).map((rule) => rule.pattern);
}

/**
 * Built-ins as sync exclusions. `*.assets` is left out on purpose: the notes
 * walker already skips asset folders, while the ASSETS walker must still
 * descend into them (they hold the images notes embed).
 */
export const BUILT_IN_SYNC_EXCLUDED_PATTERNS: readonly string[] =
	BUILT_IN_HIDDEN_PATTERNS.filter((pattern) => pattern !== "*.assets");

/** Exclusion entries for Cloud Sync's walk and watchers: built-ins plus every non-synced rule. */
export function syncExcludedEntries(scope: FilesScope): string[] {
	return [
		...BUILT_IN_SYNC_EXCLUDED_PATTERNS,
		...scope.rules.filter((rule) => !rule.synced).map((rule) => rule.pattern),
	];
}

/**
 * Makes exactly `patterns` the non-synced set (the large-folder flow and the
 * first-sync review speak in plain exclusion lists): listed rows become
 * Synced ✗ (added as In app ✓ if new), unlisted in-app rows become Synced ✓.
 */
export function withSyncExclusions(
	scope: FilesScope,
	patterns: readonly string[],
): FilesScope {
	const wanted = new Set(patterns.map((pattern) => pattern.trim()));
	const rules = scope.rules.map((rule) => ({
		...rule,
		synced: rule.inApp && !wanted.has(rule.pattern),
	}));
	for (const pattern of wanted) {
		if (!rules.some((rule) => rule.pattern === pattern))
			rules.push({ pattern, inApp: true, synced: false });
	}
	return { ...scope, rules: normalizeFilesScopeRules(rules) };
}
