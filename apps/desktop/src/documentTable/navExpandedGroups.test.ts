// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getInitialState, serialize } from "../store/persistence";
import { workspaceStore } from "../store/state";
import { STORAGE_KEY } from "../store/storage";
import {
	getNavGroupOverrides,
	isNavGroupExpanded,
	NAV_GROUP_MAX_IDS_PER_SCOPE,
	navGroupScopeKey,
	pruneDeletedSavedViewGroups,
	setNavGroupStates,
} from "./navExpandedGroups";

const WS = "/ws";
const FOLDER = navGroupScopeKey("folder", "folder");
const SAVED_A = navGroupScopeKey("saved:a", "group:tag");
const SAVED_B = navGroupScopeKey("saved:b", "group:tag");

function collapse(scope: string, id: string) {
	setNavGroupStates(WS, scope, [
		{ id, expanded: false, defaultExpanded: true },
	]);
}

describe("per-view group collapse state", () => {
	afterEach(() => {
		workspaceStore.set((state) => ({ ...state, navGroupExpansion: {} }));
		vi.unstubAllGlobals();
	});

	it("keeps views separate", () => {
		collapse(SAVED_A, "work");
		expect(getNavGroupOverrides(WS, SAVED_A)).toEqual({ work: false });
		expect(getNavGroupOverrides(WS, SAVED_B)).toEqual({});
		expect(getNavGroupOverrides(WS, FOLDER)).toEqual({});
	});

	it("survives a reload through local storage", () => {
		collapse(SAVED_A, "work");
		const written = JSON.stringify(
			serialize({ ...getInitialState(), workspace: workspaceStore.get() }),
		);
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => (key === STORAGE_KEY ? written : null),
			setItem: () => {},
		});
		expect(getInitialState().workspace.navGroupExpansion[WS]).toEqual({
			[SAVED_A]: { work: false },
		});
	});

	it("drops the legacy flat set and malformed entries on load", () => {
		vi.stubGlobal("localStorage", {
			setItem: () => {},
			getItem: () =>
				JSON.stringify({
					workspace: {
						navExpandedGroups: { [WS]: ["notes"] },
						navGroupExpansion: { [WS]: { [FOLDER]: { a: false, b: "x" } } },
					},
				}),
		});
		expect(getInitialState().workspace.navGroupExpansion).toEqual({
			[WS]: { [FOLDER]: { a: false } },
		});
	});

	it("does not leak into a different grouping of the same view", () => {
		collapse(navGroupScopeKey("saved:a", "group:tag"), "work");
		expect(
			getNavGroupOverrides(WS, navGroupScopeKey("saved:a", "group:folder")),
		).toEqual({});
	});

	it("prunes deleted saved views only", () => {
		collapse(SAVED_A, "work");
		collapse(SAVED_B, "work");
		collapse(FOLDER, "notes");
		pruneDeletedSavedViewGroups(WS, new Set(["b"]));
		expect(
			Object.keys(workspaceStore.get().navGroupExpansion[WS] ?? {}),
		).toEqual([SAVED_B, FOLDER]);
	});

	it("treats a renamed group (new key) as new: default state", () => {
		collapse(FOLDER, "notes");
		const overrides = getNavGroupOverrides(WS, FOLDER);
		expect(isNavGroupExpanded(overrides, "journal", true)).toBe(true);
		expect(isNavGroupExpanded(overrides, "__untagged__", false)).toBe(false);
	});

	it("stores only deviations, so toggling back to default removes the entry", () => {
		collapse(FOLDER, "notes");
		setNavGroupStates(WS, FOLDER, [
			{ id: "notes", expanded: true, defaultExpanded: true },
		]);
		expect(getNavGroupOverrides(WS, FOLDER)).toEqual({});
	});

	it("caps entries per scope, dropping the oldest", () => {
		setNavGroupStates(
			WS,
			FOLDER,
			Array.from({ length: NAV_GROUP_MAX_IDS_PER_SCOPE + 5 }, (_u, i) => ({
				id: `g${i}`,
				expanded: false,
				defaultExpanded: true,
			})),
		);
		const ids = Object.keys(getNavGroupOverrides(WS, FOLDER));
		expect(ids).toHaveLength(NAV_GROUP_MAX_IDS_PER_SCOPE);
		expect(ids).not.toContain("g0");
	});
});
