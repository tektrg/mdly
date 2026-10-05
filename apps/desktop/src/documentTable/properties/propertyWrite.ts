/**
 * Writes one front-matter value from a view (board drag, calendar drop).
 *
 * Safety rules, in order — each failure writes nothing and says why:
 * 1. The note open in the editor with unsaved edits is never touched: its
 *    buffer is the user's, and a disk write under it would be clobbered (or
 *    clobber it).
 * 2. The edit itself is `setFrontMatterValue` (one key's line, every other
 *    byte kept; refuses what it cannot edit with certainty).
 * 3. Compare-and-swap: the file is re-read right before the write and the
 *    write aborts if it changed since the edit was computed.
 * 4. The write goes through the editor's own path: an open note via
 *    `savePathContent` (buffer + baseline move together), any other note via
 *    `writeFileText`. Both tag the save `manual`, so doc history records a
 *    revision and the history watcher skips the echo.
 * 5. The property scan is updated for that path at once (the next listing
 *    refresh re-reads it by mtime anyway).
 */
import {
	type FrontMatterEditValue,
	parseMarkdownFrontMatter,
	setFrontMatterValue,
} from "@mdly/workspace-kit/engine";
import { desktopApi } from "../../desktopApi";
import {
	savePathContent,
	touchFile,
	updateEditorContent,
} from "../../store/actions";
import { flushEditorDraft } from "../../store/editorDraft";
import { viewerStore } from "../../store/state";
import { propertyScanStore } from "./propertyScanStore";
import { toScannedProperties } from "./scannedProperties";

export type PropertyWriteResult =
	| { ok: true; changed: boolean }
	| { ok: false; reason: string };

const HISTORY_CAUSE = "manual" as const;

function refuse(reason: string): PropertyWriteResult {
	return { ok: false, reason };
}

/** The open note's state when `path` is the note in the editor, else null. */
function openNoteState(path: string) {
	const viewer = viewerStore.get();
	return viewer.currentPath === path ? viewer : null;
}

/** Folds the new text's properties into the scan for this one path. */
function updateScanForPath(path: string, text: string) {
	const parsed = parseMarkdownFrontMatter(text);
	const properties =
		parsed.type === "valid" ? toScannedProperties(parsed.properties) : {};
	propertyScanStore.set((state) => {
		const propertiesByPath = { ...state.propertiesByPath };
		if (Object.keys(properties).length > 0) propertiesByPath[path] = properties;
		else delete propertiesByPath[path];
		return { ...state, propertiesByPath };
	});
}

/** A note as a view row knows it (see `DocumentTableRow`). */
export type PropertyWriteTarget = {
	/** Listing path: what the scan and the file list are keyed by. */
	path: string;
	/** The path the editor opens (a symlink's canonical target); read and written. */
	openPath: string;
};

/** Sets (null removes) `key` in the target note. */
export async function writeDocumentProperty(
	target: PropertyWriteTarget,
	key: string,
	value: FrontMatterEditValue | null,
): Promise<PropertyWriteResult> {
	const path = target.openPath;
	flushEditorDraft();
	const openBefore = openNoteState(path);
	if (openBefore && openBefore.content !== openBefore.diskContent) {
		return refuse("This note has unsaved edits. Save it, then try again.");
	}

	let original: string;
	try {
		original = await desktopApi.readFileText(path);
	} catch (error) {
		return refuse(`The note could not be read: ${String(error)}`);
	}
	const openNow = openNoteState(path);
	if (openNow && openNow.diskContent !== original) {
		return refuse(
			"This note changed on disk. Wait for it to reload, then try again.",
		);
	}

	const edit = setFrontMatterValue(original, key, value);
	if (!edit.ok) return refuse(edit.reason);
	if (!edit.changed) return { ok: true, changed: false };

	// Compare-and-swap: abort if anything wrote the file since the read above.
	let current: string;
	try {
		current = await desktopApi.readFileText(path);
	} catch (error) {
		return refuse(`The note could not be read: ${String(error)}`);
	}
	if (current !== original) {
		return refuse("This note changed while saving. Nothing was written.");
	}

	flushEditorDraft();
	const openAtWrite = openNoteState(path);
	if (openAtWrite) {
		if (
			openAtWrite.content !== openAtWrite.diskContent ||
			openAtWrite.diskContent !== original
		) {
			return refuse("This note has unsaved edits. Save it, then try again.");
		}
		// Through the editor: the buffer and its baseline move together.
		updateEditorContent(path, edit.text);
		await savePathContent(path, edit.text, { historyCause: HISTORY_CAUSE });
		if (viewerStore.get().diskContent !== edit.text) {
			return refuse("The note could not be saved.");
		}
	} else {
		try {
			await desktopApi.writeFileText(path, edit.text, {
				historyCause: HISTORY_CAUSE,
			});
		} catch (error) {
			return refuse(`The note could not be saved: ${String(error)}`);
		}
		touchFile(target.path);
	}
	updateScanForPath(target.path, edit.text);
	return { ok: true, changed: true };
}
