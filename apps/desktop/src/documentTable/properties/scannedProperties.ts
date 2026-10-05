import type { FileProperty } from "@mdly/workspace-kit/engine";
import type { ScannedFrontMatterProperty } from "../../desktopApi/types";

/**
 * Parsed front-matter properties as the scan's record, keyed by the key as
 * written. One mapping shared by the main-process head scan and the
 * renderer's optimistic update after a property write, so the two can never
 * disagree about what a file "has".
 */
export function toScannedProperties(
	properties: readonly FileProperty[],
): Record<string, ScannedFrontMatterProperty> {
	const scanned: Record<string, ScannedFrontMatterProperty> = {};
	for (const property of properties) {
		if (property.type === "unsupported") continue;
		// First occurrence wins, like the properties panel's display order.
		if (property.key in scanned) continue;
		scanned[property.key] = {
			type: property.type,
			value: property.value,
		} as ScannedFrontMatterProperty;
	}
	return scanned;
}
