import { diffRegions } from "@mdly/doc-history";
import type { AnchorResolution, TextAnchor } from "./types.js";

/**
 * Reads revision content for anchor resolution fallback.
 * Returns null if the revision is unavailable (evicted/undownloaded).
 */
export type ReadRevisionContent = (
	revisionId: string,
) => Promise<string | null>;

/**
 * Flattens a document's markdown body to rendered-text space for anchor
 * positioning. Injected by the kit — the same flatten pipeline the editor
 * uses, including Notion body normalization (D9).
 */
export type FlattenDocument = (docBody: string) => string;

/**
 * Resolves a recorded anchor against the current document's flattened text.
 *
 * - mode 'revision' with an available blob: replay the recorded [from,to)
 *   range through a diffRegions walk from the revision's flattened text to
 *   the current flattened text (R11). Any overlap with a changed region
 *   orphans rather than clips or guesses (R12).
 * - mode 'quote', or mode 'revision' whose blob is unavailable: fall back to
 *   quote(+context) matching against the current text (R12).
 */
export async function resolveAnchor(
	recorded: TextAnchor,
	currentFlattenedText: string,
	readRevisionContent: ReadRevisionContent,
	flattenDocument: FlattenDocument,
): Promise<AnchorResolution> {
	if (recorded.mode === "revision" && recorded.revisionId) {
		const revisionBody = await readRevisionContent(recorded.revisionId);
		if (revisionBody !== null) {
			const revisionFlattened = flattenDocument(revisionBody);
			return replayThroughRegions(
				recorded,
				revisionFlattened,
				currentFlattenedText,
			);
		}
	}
	return resolveByQuoteContext(recorded, currentFlattenedText);
}

function replayThroughRegions(
	recorded: TextAnchor,
	oldText: string,
	newText: string,
): AnchorResolution {
	if (oldText === newText) {
		if (recorded.to <= newText.length) {
			return {
				status: "anchored",
				range: { from: recorded.from, to: recorded.to },
				method: "revision-replay",
			};
		}
		return { status: "orphaned" };
	}

	const regions = diffRegions(oldText, newText);
	let oldPos = 0;
	let newPos = 0;
	let mappedFrom: number | null = null;
	let mappedTo: number | null = null;
	let coveredLength = 0;

	for (const region of regions) {
		const length = region.value.length;
		if (region.type === "unchanged") {
			const oldEnd = oldPos + length;
			const overlapFrom = Math.max(recorded.from, oldPos);
			const overlapTo = Math.min(recorded.to, oldEnd);
			if (overlapFrom < overlapTo) {
				const mFrom = newPos + (overlapFrom - oldPos);
				const mTo = newPos + (overlapTo - oldPos);
				mappedFrom = mappedFrom === null ? mFrom : Math.min(mappedFrom, mFrom);
				mappedTo = mappedTo === null ? mTo : Math.max(mappedTo, mTo);
				coveredLength += overlapTo - overlapFrom;
			}
			oldPos += length;
			newPos += length;
		} else if (region.type === "removed") {
			oldPos += length;
		} else {
			newPos += length;
		}
	}

	const recordedLength = recorded.to - recorded.from;
	if (
		mappedFrom !== null &&
		mappedTo !== null &&
		coveredLength === recordedLength &&
		mappedTo > mappedFrom
	) {
		return {
			status: "anchored",
			range: { from: mappedFrom, to: mappedTo },
			method: "revision-replay",
		};
	}
	return { status: "orphaned" };
}

function resolveByQuoteContext(
	recorded: TextAnchor,
	text: string,
): AnchorResolution {
	if (recorded.quote.length === 0) {
		return { status: "orphaned" };
	}

	const occurrences: number[] = [];
	let idx = text.indexOf(recorded.quote);
	while (idx !== -1) {
		occurrences.push(idx);
		idx = text.indexOf(recorded.quote, idx + 1);
	}

	if (occurrences.length === 0) {
		return { status: "orphaned" };
	}

	const candidates =
		occurrences.length === 1
			? occurrences
			: disambiguateByContext(recorded, text, occurrences);

	if (candidates.length !== 1) {
		return { status: "orphaned" };
	}

	const from = candidates[0];
	return {
		status: "fallback-anchored",
		range: { from, to: from + recorded.quote.length },
		method: "quote-context",
	};
}

function disambiguateByContext(
	recorded: TextAnchor,
	text: string,
	occurrences: number[],
): number[] {
	const contextBefore = recorded.contextBefore ?? "";
	const contextAfter = recorded.contextAfter ?? "";
	if (contextBefore.length === 0 && contextAfter.length === 0) {
		return occurrences;
	}
	return occurrences.filter((from) => {
		const to = from + recorded.quote.length;
		const beforeOk =
			contextBefore.length === 0 ||
			text.slice(Math.max(0, from - contextBefore.length), from) ===
				contextBefore;
		const afterOk =
			contextAfter.length === 0 ||
			text.slice(to, to + contextAfter.length) === contextAfter;
		return beforeOk && afterOk;
	});
}
