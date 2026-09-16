/**
 * Session-only identity for a table node (ruling D3 / charter R24).
 *
 * Minted when Markdown is parsed into a document and carried on the table
 * node's `uid` attribute, which is never serialized to Markdown and never
 * rendered to the DOM — so it cannot reach the saved file, the clipboard, a
 * revision diff or the outline. Later stages key session-only state (e.g.
 * full-width mode) to it.
 *
 * Deliberately random rather than positional: a predictable id would leave a
 * table looking expanded after an external rewrite replaced it with a
 * different one. The counter only guarantees two ids minted in the same
 * millisecond still differ, so two parsed copies of the same table — a
 * copy-paste — are always distinct.
 */
let mintedTableUidCount = 0;

export function createTableUid(): string {
	mintedTableUidCount += 1;
	const random = Math.random().toString(36).slice(2, 10);
	return `tbl-${random}-${mintedTableUidCount}`;
}
