/**
 * Union merge for append-only sidecar JSONL event logs (Round 3,
 * codename sidecar-union-plan).
 *
 * WHY: each device writes its own comment file and every reader merges all
 * of them, so a diverged comment log must converge in one round instead of
 * ping-ponging numbered siblings forever. The merge is a plain union:
 * dedupe by event id, sort, emit. Both devices merging the same pair
 * converge to byte-identical output.
 *
 * Rules:
 * - A line that JSON-parses to a non-null, non-array object with a string
 *   `id` is keyed by that id and deduped across both sides.
 * - Any other line (blank, truncated, unparseable, or id-less) is kept and
 *   deduped by exact text.
 * - Same id with different payloads (hand edit, truncated-then-appended
 *   file) is NOT treated as impossible: the lexicographically greater full
 *   line wins, deterministically, so the merge stays commutative.
 * - Emit id-carrying lines first sorted ascending by id with plain string
 *   comparison (ids are base36 and time-sortable), then id-less lines
 *   sorted lexicographically, one per line, with a single trailing newline.
 * - Empty union (both sides empty / whitespace-free of lines) returns "".
 */
export function mergeJsonlUnion(localText: string, remoteText: string): string {
	const byId = new Map<string, string>();
	const idLess = new Set<string>();

	for (const text of [localText, remoteText]) {
		for (const line of splitLogLines(text)) {
			const id = eventIdOf(line);
			if (id !== undefined) {
				const prev = byId.get(id);
				// Lexicographically greater full line wins: deterministic
				// under argument order, so merge(a, b) === merge(b, a) even
				// when a hand edit produced two payloads for one id.
				if (prev === undefined || line > prev) byId.set(id, line);
			} else {
				idLess.add(line);
			}
		}
	}

	const ids = [...byId.keys()].sort(compareStrings);
	const tails = [...idLess].sort(compareStrings);
	const out = [...ids.map((id) => byId.get(id) as string), ...tails];
	if (out.length === 0) return "";
	return `${out.join("\n")}\n`;
}

/**
 * Split log text into lines without treating the artifact of a trailing
 * newline as a blank line. Interior blanks (including a lone "\n" input)
 * are preserved as real id-less lines.
 */
function splitLogLines(text: string): string[] {
	if (text === "") return [];
	const parts = text
		.split("\n")
		.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	// Drop only the artifact segment produced by a trailing newline.
	if (text.endsWith("\n")) parts.pop();
	return parts;
}

/** The event id when the line is an id-carrying event, else undefined. */
function eventIdOf(line: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return undefined;
	}
	const id = (parsed as Record<string, unknown>).id;
	return typeof id === "string" ? id : undefined;
}

function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Merge for `.hubble/views.json` (saved views, R24) — a JSON document, not a
 * JSONL log, so the line union above would corrupt it. Views merge by `id`,
 * local first and winning on a shared id; other top-level fields are taken
 * from local over remote. Returns null when either side is not a readable
 * views file (the caller then plans nothing, so no side is ever clobbered).
 */
export function mergeViewsJson(
	localText: string,
	remoteText: string,
): string | null {
	const local = parseViews(localText);
	const remote = parseViews(remoteText);
	if (!local || !remote) return null;
	const ids = new Set<string>();
	const views: unknown[] = [];
	for (const view of [...local.views, ...remote.views]) {
		const id =
			typeof view === "object" && view !== null && !Array.isArray(view)
				? (view as { id?: unknown }).id
				: undefined;
		if (typeof id === "string") {
			if (ids.has(id)) continue;
			ids.add(id);
		}
		views.push(view);
	}
	const { version, views: _l, ...localExtra } = local;
	const { version: _v, views: _r, ...remoteExtra } = remote;
	return `${JSON.stringify({ version, views, ...remoteExtra, ...localExtra }, null, 2)}\n`;
}

function parseViews(
	text: string,
): ({ version: number; views: unknown[] } & Record<string, unknown>) | null {
	try {
		const data = JSON.parse(text);
		if (
			typeof data !== "object" ||
			data === null ||
			Array.isArray(data) ||
			data.version !== 1 ||
			!Array.isArray(data.views)
		) {
			return null;
		}
		return data;
	} catch {
		return null;
	}
}
