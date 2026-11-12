/**
 * `hubble views list|create|rename|delete`: manage mdly saved views (the named
 * views in the view-switcher row at the top of the document table, next to
 * Recent/Folder/Tags) from the terminal. Records, checks and the file writer all
 * come from `@tektrg/table-core` — the same code the mdly app and its MCP
 * tools use — so a view made here looks exactly like one made in the app.
 *
 * Every input check runs before anything is written; any error prints one
 * clear line to stderr and exits non-zero with the file untouched.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type SavedViewRecord,
	sanitizeSavedView,
	savedViewFolders,
} from "@tektrg/table-core";
import {
	createWorkspaceViewStore,
	runViewCommand,
	type ViewCommand,
	type WorkspaceViewStore,
} from "@tektrg/table-core/node";

/**
 * mdly-only view keys, beside table-core's record (the app reads both):
 * `pathFilters` = comma-separated path patterns (plain = substring, `*` = any
 * run, `/…/` = regex; case-insensitive) on `folder/sub/file.md`;
 * `groupByKind` = folder | topFolder | tag grouping (with `groupBy: null`).
 */
const GROUP_KINDS: Record<string, string> = {
	folder: "folder",
	"top-folder": "topFolder",
	tag: "tag",
};
const GROUP_KIND_LABELS: Record<string, string> = {
	folder: "folder",
	topFolder: "top-folder",
	tag: "tag",
};

type MdlyExtras = { pathFilters?: string[]; groupByKind?: string };

/** The store, with `extras` merged into the record `id` as it is written. */
function storeWithExtras(
	workspace: string,
	id: string,
	extras: MdlyExtras,
): WorkspaceViewStore {
	const inner = createWorkspaceViewStore(workspace);
	const patch = <F extends { views: SavedViewRecord[] }>(file: F): F => ({
		...file,
		views: file.views.map((view) =>
			view.id === id ? ({ ...view, ...extras } as SavedViewRecord) : view,
		),
	});
	return {
		...inner,
		read: () => inner.read(),
		write: (file, snapshot) => inner.write(patch(file), snapshot),
		resetCorrupt: (file) => inner.resetCorrupt(patch(file)),
	};
}

export type ViewsIo = {
	stdout: (line: string) => void;
	stderr: (line: string) => void;
	cwd: string;
};

const defaultIo: ViewsIo = {
	stdout: (line) => console.log(line),
	stderr: (line) => console.error(line),
	cwd: process.cwd(),
};

const SUBCOMMANDS = ["list", "create", "rename", "delete"] as const;

export const VIEWS_USAGE = [
	"Usage:",
	"  hubble [--cwd path] views list [--json]",
	"  hubble [--cwd path] views create <name> [--folder dir]... [--path patterns]... [--group-by prop | --group folder|top-folder|tag] [--filter prop=value|prop]... [--json]",
	"  hubble [--cwd path] views rename <name|id> <new name> [--json]",
	"  hubble [--cwd path] views delete <name|id> [--json]",
	"",
	"Options:",
	"  --cwd path, --workspace path  Workspace folder (default: current folder)",
	"  --folder dir       Only documents in this workspace folder (subfolders included; must exist; repeatable — a document in any of them matches)",
	"  --path patterns    Only documents whose folder/sub/file.md matches: comma-separated, any matches; plain text = contains, * = anything, /…/ = regex; case-insensitive; repeatable (OR)",
	"  --group-by prop    Group rows by this front-matter property",
	"  --group kind       Group rows by folder, top-folder (first folder segment) or tag",
	"  --filter k=v       Property k is v (the value may contain '='); a bare k means 'has property k'; repeatable",
	"  --json             Machine-readable output",
	"",
	"Views are stored in <workspace>/.hubble/views.json and appear in mdly's view-switcher row at the top of the document table (next to Recent/Folder/Tags) when its window is focused.",
];

/** True when argv's first positional (after global options) is `views`. */
export function isViewsInvocation(argv: readonly string[]): boolean {
	try {
		const { positionals } = parseArgs({
			args: argv[0] === "--" ? argv.slice(1) : [...argv],
			allowPositionals: true,
			strict: false,
			options: {
				cwd: { type: "string" },
				workspace: { type: "string" },
				folder: { type: "string", multiple: true },
				"group-by": { type: "string" },
				group: { type: "string" },
				path: { type: "string", multiple: true },
				filter: { type: "string", multiple: true },
			},
		});
		return positionals[0] === "views";
	} catch {
		return false;
	}
}

function describeFilter(filter: Record<string, unknown>): string {
	const field = String(filter.fieldId ?? "").replace(/^prop:/, "");
	return filter.kind === "has"
		? `has ${field}`
		: `${field} is ${String(filter.value)}`;
}

const textOr = (value: unknown, placeholder: string) =>
	typeof value === "string" && value.trim() !== "" ? value : placeholder;

/** Human-readable lines for one record; placeholders for a missing name/id. */
export function formatView(record: SavedViewRecord): string[] {
	const view = sanitizeSavedView(record);
	const lines = [
		`${textOr(record?.name, "(unnamed)")}  (id: ${textOr(record?.id, "(no id)")})`,
	];
	if (!view) {
		lines.push("  (not usable by mdly; kept as-is)");
		return lines;
	}
	const folders = savedViewFolders(view);
	const filters = view.filters.filter((filter) => filter.kind !== "folder");
	lines.push(`  folders:  ${folders.length ? folders.join(", ") : "(all)"}`);
	const extras = record as MdlyExtras;
	const pathFilters = Array.isArray(extras.pathFilters)
		? extras.pathFilters.filter((p) => typeof p === "string")
		: [];
	const groupKind =
		typeof extras.groupByKind === "string"
			? GROUP_KIND_LABELS[extras.groupByKind]
			: undefined;
	lines.push(
		`  paths:    ${pathFilters.length ? pathFilters.join(" | ") : "(all)"}`,
	);
	lines.push(
		`  group by: ${groupKind ?? (view.groupBy ? view.groupBy.replace(/^prop:/, "") : "(none)")}`,
	);
	lines.push(
		`  filters:  ${filters.length ? filters.map((f) => describeFilter(f as Record<string, unknown>)).join(", ") : "(none)"}`,
	);
	return lines;
}

type Parsed =
	| {
			ok: true;
			workspace: string;
			json: boolean;
			command: ViewCommand;
			extras: MdlyExtras;
	  }
	| { ok: false; error: string; usage: boolean };

function parseViewsArgs(argv: readonly string[], cwd: string): Parsed {
	let values: Record<string, string | boolean | string[] | undefined>;
	let positionals: string[];
	try {
		({ values, positionals } = parseArgs({
			args: argv[0] === "--" ? argv.slice(1) : [...argv],
			allowPositionals: true,
			strict: true,
			options: {
				cwd: { type: "string" },
				workspace: { type: "string" },
				folder: { type: "string", multiple: true },
				"group-by": { type: "string" },
				group: { type: "string" },
				path: { type: "string", multiple: true },
				filter: { type: "string", multiple: true },
				json: { type: "boolean" },
			},
		}));
	} catch (error) {
		return {
			ok: false,
			usage: true,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	const [, sub, ...rest] = positionals;
	if (values.cwd !== undefined && values.workspace !== undefined) {
		return {
			ok: false,
			usage: true,
			error: "use either --cwd or --workspace, not both",
		};
	}
	const workspace = resolve(
		cwd,
		(values.workspace ?? values.cwd ?? ".") as string,
	);
	const json = values.json === true;
	const folders = (values.folder ?? []) as string[];
	const filters = (values.filter ?? []) as string[];
	const groupBy = values["group-by"] as string | undefined;
	const group = values.group as string | undefined;
	const paths = ((values.path ?? []) as string[]).map((p) => p.trim());
	if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
		return {
			ok: false,
			usage: true,
			error: sub
				? `unknown views command: ${sub}`
				: "missing views command (list|create|rename|delete)",
		};
	}
	if (
		sub !== "create" &&
		(folders.length > 0 ||
			filters.length > 0 ||
			groupBy !== undefined ||
			group !== undefined ||
			paths.length > 0)
	) {
		return {
			ok: false,
			usage: true,
			error: `--folder, --path, --group, --group-by and --filter only apply to "views create"`,
		};
	}
	if (group !== undefined && groupBy !== undefined) {
		return {
			ok: false,
			usage: true,
			error: "use either --group or --group-by, not both",
		};
	}
	if (group !== undefined && !(group in GROUP_KINDS)) {
		return {
			ok: false,
			usage: true,
			error: `bad --group ${JSON.stringify(group)}: use folder, top-folder or tag`,
		};
	}
	if (paths.some((p) => p.replace(/[\s,*]/g, "") === "")) {
		return { ok: false, usage: true, error: "--path needs a pattern" };
	}
	const extras: MdlyExtras = {
		...(paths.length > 0 ? { pathFilters: paths } : {}),
		...(group !== undefined ? { groupByKind: GROUP_KINDS[group] } : {}),
	};
	const arity = { list: 0, create: 1, rename: 2, delete: 1 }[
		sub as (typeof SUBCOMMANDS)[number]
	];
	if (rest.length !== arity) {
		return {
			ok: false,
			usage: true,
			error: `"views ${sub}" takes ${arity} argument${arity === 1 ? "" : "s"}, got ${rest.length}`,
		};
	}
	let command: ViewCommand;
	switch (sub) {
		case "list":
			command = { kind: "list" };
			break;
		case "create":
			command = {
				kind: "create",
				name: rest[0] as string,
				folders,
				filters,
				groupBy: groupBy ?? null,
			};
			break;
		case "rename":
			command = {
				kind: "rename",
				target: rest[0] as string,
				name: rest[1] as string,
			};
			break;
		default:
			command = { kind: "delete", target: rest[0] as string };
	}
	return { ok: true, workspace, json, command, extras };
}

/** Runs `hubble ... views ...`; returns the process exit code. */
export async function runViewsCli(
	argv: readonly string[],
	io: ViewsIo = defaultIo,
): Promise<number> {
	const parsed = parseViewsArgs(argv, io.cwd);
	if (!parsed.ok) {
		io.stderr(`hubble views: ${parsed.error}`);
		if (parsed.usage) for (const line of VIEWS_USAGE) io.stderr(line);
		return 1;
	}
	const id = randomUUID();
	const hasExtras = Object.keys(parsed.extras).length > 0;
	const result = await runViewCommand(
		parsed.workspace,
		parsed.command,
		hasExtras
			? {
					newId: () => id,
					store: storeWithExtras(parsed.workspace, id, parsed.extras),
				}
			: {},
	);
	if ("error" in result) {
		io.stderr(`hubble views: ${result.error.message}`);
		return 1;
	}
	for (const warning of result.warnings) {
		io.stderr(`hubble views: warning: ${warning}`);
	}
	if ("views" in result) {
		if (parsed.json) {
			io.stdout(JSON.stringify(result.views, null, 2));
		} else if (result.views.length === 0) {
			io.stdout("No saved views.");
		} else {
			for (const record of result.views) {
				for (const line of formatView(record)) io.stdout(line);
			}
		}
		return 0;
	}
	const record =
		result.kind === "create" && hasExtras
			? ({ ...result.record, ...parsed.extras } as SavedViewRecord)
			: result.record;
	if (parsed.json) {
		io.stdout(JSON.stringify(record, null, 2));
		return 0;
	}
	const verb = { create: "Created", rename: "Renamed", delete: "Deleted" }[
		result.kind
	];
	io.stdout(`${verb} view "${record.name}" (id: ${record.id})`);
	if (result.kind !== "delete") {
		for (const line of formatView(record).slice(1)) io.stdout(line);
	}
	return 0;
}
