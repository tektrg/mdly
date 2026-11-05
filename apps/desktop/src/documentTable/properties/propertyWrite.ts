/**
 * Writes one front-matter value from a view (board drag, calendar drop).
 *
 * Safety rules — each failure writes nothing and says why:
 * 1. Writes to one note run one at a time (per-path queue), so a fast double
 *    drop computes its edit from the first drop's result, not a stale read.
 * 2. The open note with unsaved edits is never touched.
 * 3. A note that is not valid UTF-8 is refused (the renderer's read is lossy).
 * 4. The edit is `setFrontMatterValue` (one key's line, every other byte kept).
 * 5. Compare-and-swap happens in the main process, next to the file:
 *    `writeFileTextIfUnchanged` checks the content right before an atomic
 *    temp-file + rename, and never recreates a deleted note. It also records
 *    the replaced version in doc history first, so an external edit the
 *    watcher never saw stays restorable.
 * 6. The editor buffer of an open note is updated only after the write
 *    succeeded, so a refusal or failure leaves it exactly as it was.
 * 7. The property scan is updated for that path at once.
 */
import {
	type FrontMatterEditValue,
	parseMarkdownFrontMatter,
	setFrontMatterValue,
} from "@mdly/workspace-kit/engine";
import { desktopApi } from "../../desktopApi";
import { touchFile } from "../../store/actions";
import { flushEditorDraft } from "../../store/editorDraft";
import { viewerStore } from "../../store/state";
import { propertyScanStore } from "./propertyScanStore";
import { toScannedProperties } from "./scannedProperties";

export type PropertyWriteResult =
	| { ok: true; changed: boolean }
	| { ok: false; reason: string };

/** A note as a view row knows it (see `DocumentTableRow`). */
export type PropertyWriteTarget = {
	/** Listing path: what the scan and the file list are keyed by. */
	path: string;
	/** The path the editor opens (a symlink's canonical target); read and written. */
	openPath: string;
};

const HISTORY_CAUSE = "manual" as const;

const UNSAVED_EDITS = "This note has unsaved edits. Save it, then try again.";

const CAS_REASONS = {
	missing: "This note no longer exists. Nothing was written.",
	changed: "This note changed while saving. Nothing was written.",
	"not-utf8": "This note is not UTF-8 text, so it was left untouched.",
} as const;

function refuse(reason: string): PropertyWriteResult {
	return { ok: false, reason };
}

function openNoteState(path: string) {
	const viewer = viewerStore.get();
	return viewer.currentPath === path ? viewer : null;
}

function updateScanForPath(path: string, text: string) {
	const parsed = parseMarkdownFrontMatter(text);
	const properties =
		parsed.type === "valid" ? toScannedProperties(parsed.properties) : {};
	propertyScanStore.set((state) => {
		const propertiesByPath = { ...state.propertiesByPath };
		if (Object.keys(properties).length > 0) propertiesByPath[path] = properties;
		else delete propertiesByPath[path];
		// A front-matter edit can turn a note's properties from unreadable to readable.
		const invalidPaths =
			parsed.type === "invalid"
				? state.invalidPaths
				: state.invalidPaths.filter((candidate) => candidate !== path);
		return { ...state, propertiesByPath, invalidPaths };
	});
}

/** Moves the open note's buffer and baseline to the written text (only if untouched). */
/**
 * Moves the open note's baseline to the written text. If the user typed
 * while the write was in flight, the same one-key edit is merged into their
 * buffer, so their next save keeps the property change. If the merge is not
 * safe, the baseline stays put: the editor then sees the disk change as an
 * external edit (auto-applied with Undo), never a silent drop.
 */
function applyWrittenTextToEditor(
	path: string,
	original: string,
	next: string,
	key: string,
	value: FrontMatterEditValue | null,
) {
	flushEditorDraft();
	viewerStore.set((state) => {
		if (state.currentPath !== path || state.diskContent !== original) {
			return state;
		}
		let content = next;
		if (state.content !== original) {
			const merged = setFrontMatterValue(state.content, key, value);
			if (!merged.ok) return state;
			content = merged.text;
		}
		return {
			...state,
			content,
			diskContent: next,
			externalChange: { kind: "none" },
			status: "ready",
			error: null,
		};
	});
}

const writeQueueByPath = new Map<string, Promise<unknown>>();

/** Runs `task` after every earlier write to the same path settled. */
function enqueueForPath<T>(path: string, task: () => Promise<T>): Promise<T> {
	const previous = writeQueueByPath.get(path) ?? Promise.resolve();
	const run = previous.then(task, task);
	const settled = run.catch(() => undefined);
	writeQueueByPath.set(path, settled);
	void settled.then(() => {
		if (writeQueueByPath.get(path) === settled) writeQueueByPath.delete(path);
	});
	return run;
}

async function writeNow(
	target: PropertyWriteTarget,
	key: string,
	value: FrontMatterEditValue | null,
): Promise<PropertyWriteResult> {
	const path = target.openPath;
	flushEditorDraft();
	const openBefore = openNoteState(path);
	if (openBefore && openBefore.content !== openBefore.diskContent) {
		return refuse(UNSAVED_EDITS);
	}

	let original: string;
	try {
		original = await desktopApi.readFileText(path);
	} catch (error) {
		return refuse(`The note could not be read: ${String(error)}`);
	}
	if (original.includes("�")) return refuse(CAS_REASONS["not-utf8"]);
	const openNow = openNoteState(path);
	if (openNow && openNow.diskContent !== original) {
		return refuse(
			"This note changed on disk. Wait for it to reload, then try again.",
		);
	}

	const edit = setFrontMatterValue(original, key, value);
	if (!edit.ok) return refuse(edit.reason);
	if (!edit.changed) return { ok: true, changed: false };

	flushEditorDraft();
	const openAtWrite = openNoteState(path);
	if (openAtWrite && openAtWrite.content !== openAtWrite.diskContent) {
		return refuse(UNSAVED_EDITS);
	}

	let result: Awaited<ReturnType<typeof desktopApi.writeFileTextIfUnchanged>>;
	try {
		result = await desktopApi.writeFileTextIfUnchanged(
			path,
			original,
			edit.text,
			{ historyCause: HISTORY_CAUSE },
		);
	} catch (error) {
		return refuse(`The note could not be saved: ${String(error)}`);
	}
	if (!result.ok) return refuse(CAS_REASONS[result.reason]);

	applyWrittenTextToEditor(path, original, edit.text, key, value);
	touchFile(target.path);
	updateScanForPath(target.path, edit.text);
	return { ok: true, changed: true };
}

/** Sets (null removes) `key` in the target note. */
export function writeDocumentProperty(
	target: PropertyWriteTarget,
	key: string,
	value: FrontMatterEditValue | null,
): Promise<PropertyWriteResult> {
	return enqueueForPath(target.openPath, () => writeNow(target, key, value));
}
