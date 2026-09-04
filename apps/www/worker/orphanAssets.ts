import { normalizeWorkspacePath } from "./paths.js";

type MarkdownFile = {
	path: string;
	content: string;
	deleted: boolean;
};

type Asset = {
	path: string;
	deleted: boolean;
	orphanedAt?: number;
};

export type OrphanAssetCandidate = {
	path: string;
	orphanedAt?: number;
};

/**
 * Admin-level reachability scan for asset cleanup.
 *
 * This intentionally scans every live note and should only be used from
 * manual or scheduled maintenance flows. It is not a hot-path primitive
 * for editor saves or sync pushes. A scalable cleanup component should maintain
 * an incremental reference index as files change, then use that index here.
 *
 * Returns the STORED paths that are referenced (not normalised forms), so
 * callers comparing against asset rows — including pre-round-4 legacy rows
 * — match exactly what is stored.
 */
export function referencedAssetPaths(
	files: MarkdownFile[],
	assets: { path: string }[],
): Set<string> {
	const liveNotes: { dir: string; normText: string }[] = [];
	for (const file of files) {
		if (!file.deleted) {
			liveNotes.push({
				dir: parentDir(file.path),
				normText: normaliseForMatch(file.content),
			});
		}
	}
	const references = new Set<string>();
	for (const asset of assets) {
		if (isAssetReferenced(asset.path, liveNotes)) {
			references.add(asset.path);
		}
	}
	return references;
}

/** Comparison form: NFC then lowercase, on both sides of every check. */
function normaliseForMatch(value: string): string {
	return value.normalize("NFC").toLowerCase();
}

/**
 * One function answering "does any live note reference this stored asset".
 * A deletion decision must fail toward keeping data, so this is a
 * raw-content containment check, not a syntax enumeration: the asset matches
 * when any live note's text contains one of its candidate spellings. Inline
 * `![]()`, reference-style links, collapsed/shortcut references, HTML
 * `<img>`, `<a href>`, CSS `url()`, front-matter, prose mentions, fenced code
 * blocks, and any future syntax all match the same way — there is no syntax
 * list to fall behind. Over-retention (a path mentioned in prose keeps its
 * asset alive) is the correct direction for a destructive operation.
 *
 * Resolution and matching are separate jobs, done together here:
 * - RESOLUTION decides which paths to look for. A reference is relative to
 *   its own note, so each asset is expressed root-relative (round 6,
 *   preserved) AND relative to each note's directory (round 5, restored) —
 *   including `./`-prefixed forms.
 * - MATCHING is the syntax-agnostic substring scan over those spellings.
 *
 * The stored row path is canonicalised before comparing, so pre-round-4
 * legacy rows (`./images/x.png`, `images//y.png`) match canonical
 * references. Comparison is case-insensitive over NFC (macOS stores NFD
 * while editors write NFC). No trimming anywhere: spaces are legal in
 * filenames and the writer stores byte-for-byte, so the matcher must too.
 */
function isAssetReferenced(
	storedPath: string,
	liveNotes: { dir: string; normText: string }[],
): boolean {
	for (const note of liveNotes) {
		for (const variant of assetSearchStrings(storedPath, note.dir)) {
			if (variant !== "" && note.normText.includes(variant)) return true;
		}
	}
	return false;
}

function assetSearchStrings(storedPath: string, noteDir: string): string[] {
	const canonical = normalizeWorkspacePath(storedPath);
	const raws = canonical === null ? [storedPath] : [canonical, storedPath];
	const out: string[] = [];
	const add = (s: string) => {
		const norm = normaliseForMatch(s);
		if (norm !== "" && !out.includes(norm)) out.push(norm);
	};
	for (const raw of raws) {
		// Every normalisation form gets its own encoded variants: percent
		// escapes are ASCII, so normalising AFTER encoding can no longer
		// reach the encoded bytes (NFD `cafe%CC%81` vs NFC `caf%C3%A9` would
		// never meet). Emit NFC and NFD spellings BEFORE encoding.
		for (const unformed of unfoldings(raw)) {
			for (const form of pathForms(unformed, noteDir)) {
				add(form);
				add(encodePathSegments(form));
				add(encodePathSegmentsKeepSpaces(form));
				add(form.replaceAll("/", "\\"));
			}
		}
	}
	return out;
}

/** The raw spelling plus its NFC and NFD forms (either may be absent when
 * the input is already in that form or cannot be normalised). */
function unfoldings(raw: string): string[] {
	const out = [raw];
	for (const form of ["NFC", "NFD"] as const) {
		try {
			const normalised = raw.normalize(form);
			if (normalised !== raw && !out.includes(normalised)) {
				out.push(normalised);
			}
		} catch {
			// Lone surrogates cannot be normalised — keep the raw spelling.
		}
	}
	return out;
}

/**
 * How one stored path may be spelled from one note: the root-relative form
 * plus the form relative to the note's own directory (with and without a
 * `./` prefix). `<note>.assets/` — this product's default image folder — is
 * exactly the "under my own directory" case, which is why resolution matters.
 */
function pathForms(base: string, noteDir: string): string[] {
	const forms = [base];
	let rel = "";
	if (noteDir === "") {
		rel = base;
	} else {
		// Segment-wise climb: strip the common prefix, then one `..` per
		// remaining note directory (`a/b` → `a/sibling…` is `../sibling…`,
		// not `../../a/sibling…`). Prefix comparison is case/NFC-folded;
		// the emitted segments keep the stored spelling.
		const dSegs = noteDir.split("/");
		const bSegs = base.split("/");
		let common = 0;
		while (
			common < dSegs.length &&
			common < bSegs.length &&
			normaliseForMatch(dSegs[common] as string) ===
				normaliseForMatch(bSegs[common] as string)
		) {
			common++;
		}
		rel = [
			...Array<string>(dSegs.length - common).fill(".."),
			...bSegs.slice(common),
		].join("/");
	}
	if (rel !== "") {
		forms.push(rel, `./${rel}`);
	}
	return forms;
}

/** Percent-encodes each `/`-separated segment (`#` → `%23`, `?` → `%3F`,
 * space → `%20`), leaving the separators intact. Never throws: a segment
 * that cannot be encoded is kept raw. */
function encodePathSegments(path: string): string {
	return path
		.split("/")
		.map((segment) => {
			try {
				return encodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join("/");
}

/**
 * Partially-encoded form: reserved characters encoded, spaces left raw
 * (`note assets/a%23b.png`). Hand-written references encode the characters
 * that would break parsing (`#`, `?`) but leave spaces alone — matching
 * neither the raw nor the fully-encoded spelling without this variant.
 */
function encodePathSegmentsKeepSpaces(path: string): string {
	return encodePathSegments(path).replaceAll("%20", " ");
}

function parentDir(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Returns assets with zero markdown references at scan time.
 *
 * Candidates are not safe to delete immediately: undo, cut/paste, sync ordering,
 * and shared references can make a single scan temporarily incomplete. Callers
 * should first mark candidates with `orphanedAt`, then delete only after a grace
 * period if a later scan still finds no references.
 */
export function orphanAssetCandidates(
	files: MarkdownFile[],
	assets: Asset[],
): OrphanAssetCandidate[] {
	const references = referencedAssetPaths(files, assets);
	return assets
		.filter((asset) => !asset.deleted && !references.has(asset.path))
		.map((asset) => ({
			path: asset.path,
			orphanedAt: asset.orphanedAt,
		}));
}

export function assetCleanupDeviceId(): string {
	return ASSET_DEVICE_ID;
}

const ASSET_DEVICE_ID = "asset-orphan-cleanup";
