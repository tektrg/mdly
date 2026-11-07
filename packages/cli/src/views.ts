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
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type SavedViewRecord,
	sanitizeSavedView,
	savedViewFolders,
} from "@tektrg/table-core";
import { runViewCommand, type ViewCommand } from "@tektrg/table-core/node";

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
	"  hubble [--cwd path] views create <name> [--folder dir]... [--group-by prop] [--filter prop=value|prop]... [--json]",
	"  hubble [--cwd path] views rename <name|id> <new name> [--json]",
	"  hubble [--cwd path] views delete <name|id> [--json]",
	"",
	"Options:",
	"  --cwd path, --workspace path  Workspace folder (default: current folder)",
	"  --folder dir       Only documents in this workspace folder (subfolders included; must exist; repeatable — a document in any of them matches)",
	"  --group-by prop    Group rows by this front-matter property",
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
	lines.push(
		`  group by: ${view.groupBy ? view.groupBy.replace(/^prop:/, "") : "(none)"}`,
	);
	lines.push(
		`  filters:  ${filters.length ? filters.map((f) => describeFilter(f as Record<string, unknown>)).join(", ") : "(none)"}`,
	);
	return lines;
}

type Parsed =
	| { ok: true; workspace: string; json: boolean; command: ViewCommand }
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
		(folders.length > 0 || filters.length > 0 || groupBy !== undefined)
	) {
		return {
			ok: false,
			usage: true,
			error: `--folder, --group-by and --filter only apply to "views create"`,
		};
	}
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
	return { ok: true, workspace, json, command };
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
	const result = await runViewCommand(parsed.workspace, parsed.command);
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
	if (parsed.json) {
		io.stdout(JSON.stringify(result.record, null, 2));
		return 0;
	}
	const verb = { create: "Created", rename: "Renamed", delete: "Deleted" }[
		result.kind
	];
	io.stdout(`${verb} view "${result.record.name}" (id: ${result.record.id})`);
	if (result.kind !== "delete") {
		for (const line of formatView(result.record).slice(1)) io.stdout(line);
	}
	return 0;
}
