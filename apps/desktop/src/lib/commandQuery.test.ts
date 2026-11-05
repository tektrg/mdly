import { describe, expect, it } from "vitest";
import {
	findScopeTrigger,
	insertScopeToken,
	resolveFolderScope,
	resolveNotionScope,
	resolveWorkspaceScope,
} from "./commandQuery";

const folders = [
	{
		path: "/workspace/notes",
		label: "notes",
		relativePath: "notes",
	},
	{
		path: "/workspace/Product Specs",
		label: "Product Specs",
		relativePath: "Product Specs",
	},
	{
		path: "/workspace/archive/notes",
		label: "notes",
		relativePath: "archive/notes",
	},
];

describe("command query scopes", () => {
	it("detects an @ scope trigger at the active token", () => {
		expect(findScopeTrigger("@")).toEqual({ start: 0, end: 1, filter: "" });
		expect(findScopeTrigger("roadmap @no")).toEqual({
			start: 8,
			end: 11,
			filter: "no",
		});
		expect(findScopeTrigger("@notion:")).toBeNull();
	});

	it("inserts scope tokens over the active @ trigger", () => {
		expect(
			insertScopeToken("roadmap @fo", findScopeTrigger("roadmap @fo"), "folder"),
		).toBe("roadmap @folder:");
		expect(insertScopeToken("roadmap", null, "notion")).toBe(
			"roadmap @notion ",
		);
		expect(
			insertScopeToken("project @wo", findScopeTrigger("project @wo"), "workspace"),
		).toBe("project @workspace ");
	});

	it("resolves exact folder scope values and keeps the remaining file query", () => {
		expect(resolveFolderScope("@folder:Product Specs roadmap", folders)).toEqual(
			{
				kind: "resolved",
				folder: folders[1],
				searchQuery: "roadmap",
			},
		);
	});

	it("keeps folder scope in editing mode until an exact folder resolves", () => {
		expect(resolveFolderScope("@folder:Product", folders)).toEqual({
			kind: "editing",
			input: "Product",
			searchQuery: "",
		});
	});

	it("does not auto-resolve duplicate folder labels", () => {
		expect(resolveFolderScope("@folder:notes", folders)).toEqual({
			kind: "editing",
			input: "notes",
			searchQuery: "",
		});
	});

	it("requires a Notion account when more than one account is available", () => {
		expect(resolveNotionScope("@notion roadmap", ["7lab", "stv"])).toEqual({
			kind: "needs-account",
			input: "",
			accounts: ["7lab", "stv"],
			searchQuery: "roadmap",
		});
	});

	it("allows account-less Notion search when only one account is available", () => {
		expect(resolveNotionScope("@notion roadmap", ["7lab"])).toEqual({
			kind: "ready",
			account: "7lab",
			searchQuery: "roadmap",
		});
	});

	it("resolves explicit Notion accounts", () => {
		expect(resolveNotionScope("@notion:7lab roadmap", ["7lab", "stv"])).toEqual({
			kind: "ready",
			account: "7lab",
			searchQuery: "roadmap",
		});
	});

	it("resolves active workspace scopes and keeps the remaining query", () => {
		expect(resolveWorkspaceScope("@workspace notes")).toEqual({
			kind: "active",
			searchQuery: "notes",
		});
		expect(resolveWorkspaceScope("notes @workspace personal")).toEqual({
			kind: "active",
			searchQuery: "notes personal",
		});
		expect(resolveWorkspaceScope("roadmap")).toEqual({ kind: "none" });
	});
});
