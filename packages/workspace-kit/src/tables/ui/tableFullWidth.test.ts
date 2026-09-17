// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquirePaneContainer,
	isTableExpanded,
	nudgeTableOverlays,
	setTableExpanded,
} from "./tableFullWidth.js";

beforeEach(() => {
	// The session store is module-level: collapse every uid touched by a case
	// so cases never leak expanded state into each other.
	for (const uid of ["tbl-a", "tbl-b", "tbl-c"]) setTableExpanded(uid, false);
});

describe("session-only expanded state (R23)", () => {
	it("starts collapsed and toggles per uid", () => {
		expect(isTableExpanded("tbl-a")).toBe(false);
		setTableExpanded("tbl-a", true);
		expect(isTableExpanded("tbl-a")).toBe(true);
		setTableExpanded("tbl-a", false);
		expect(isTableExpanded("tbl-a")).toBe(false);
	});

	it("is independent per table: expanding one leaves its sibling collapsed", () => {
		setTableExpanded("tbl-a", true);
		expect(isTableExpanded("tbl-b")).toBe(false);
	});
});

describe("overlay re-measure nudge (R25)", () => {
	it("emits exactly one synthetic transaction event per toggle and dispatches nothing", () => {
		const emit = vi.fn();
		nudgeTableOverlays({ emit });
		expect(emit).toHaveBeenCalledTimes(1);
		expect(emit).toHaveBeenCalledWith(
			"transaction",
			expect.objectContaining({
				transaction: expect.objectContaining({
					docChanged: true,
					steps: [],
					selectionSet: false,
				}),
			}),
		);
	});
});

describe("pane query container (R20)", () => {
	it("installs inline-size containment and restores the previous value on last release", () => {
		const pane = document.createElement("div");
		expect(pane.style.getPropertyValue("container-type")).toBe("");
		const release = acquirePaneContainer(pane);
		expect(pane.style.getPropertyValue("container-type")).toBe("inline-size");
		release();
		expect(pane.style.getPropertyValue("container-type")).toBe("");
	});

	it("is reference-counted across tables sharing one pane", () => {
		const pane = document.createElement("div");
		const releaseA = acquirePaneContainer(pane);
		const releaseB = acquirePaneContainer(pane);
		releaseA();
		expect(pane.style.getPropertyValue("container-type")).toBe("inline-size");
		releaseB();
		expect(pane.style.getPropertyValue("container-type")).toBe("");
	});

	it("release is idempotent", () => {
		const pane = document.createElement("div");
		const release = acquirePaneContainer(pane);
		release();
		release();
		expect(pane.style.getPropertyValue("container-type")).toBe("");
	});

	it("leaves a pre-existing container-type untouched", () => {
		const pane = document.createElement("div");
		pane.style.setProperty("container-type", "inline-size");
		const release = acquirePaneContainer(pane);
		release();
		expect(pane.style.getPropertyValue("container-type")).toBe("inline-size");
	});
});
