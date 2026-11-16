import { describe, expect, it } from "vitest";
import {
	COLLAPSED_PROPERTY_LIMIT,
	collapsedPropertyView,
} from "./FilePropertiesPanel";

describe("collapsedPropertyView", () => {
	it("caps a long list at 3 with the rest behind the toggle", () => {
		expect(COLLAPSED_PROPERTY_LIMIT).toBe(3);
		expect(collapsedPropertyView(7, false)).toEqual({
			visible: 3,
			hidden: 4,
			canToggle: true,
		});
	});

	it("shows everything once expanded, toggle still offered", () => {
		expect(collapsedPropertyView(7, true)).toEqual({
			visible: 7,
			hidden: 0,
			canToggle: true,
		});
	});

	it("never offers a toggle when the list fits", () => {
		for (const total of [0, 1, 3]) {
			expect(collapsedPropertyView(total, false)).toEqual({
				visible: total,
				hidden: 0,
				canToggle: false,
			});
		}
	});
});
