import { describe, expect, it } from "vitest";
import { buildWorkspaceChoices } from "./workspaceChoices";

describe("buildWorkspaceChoices", () => {
	it("puts the current workspace first and marks it current", () => {
		const choices = buildWorkspaceChoices({
			workspacePath: "/Users/me/current-notes",
			recentWorkspaces: ["/Users/me/other-notes"],
			query: "",
		});

		expect(choices[0]).toEqual({
			kind: "workspace",
			path: "/Users/me/current-notes",
			label: "current-notes",
			detail: "/Users/me/current-notes",
			current: true,
		});
	});

	it("keeps other recent workspaces in persisted order", () => {
		const choices = buildWorkspaceChoices({
			workspacePath: "/Users/me/current-notes",
			recentWorkspaces: ["/Users/me/client-notes", "/Users/me/project-notes"],
			query: "",
		});

		expect(choices.slice(0, 3).map((choice) => choice.label)).toEqual([
			"current-notes",
			"client-notes",
			"project-notes",
		]);
	});

	it("does not repeat the current workspace from recents", () => {
		const choices = buildWorkspaceChoices({
			workspacePath: "/Users/me/current-notes",
			recentWorkspaces: ["/Users/me/current-notes", "/Users/me/project-notes"],
			query: "",
		});

		expect(
			choices.filter(
				(choice) =>
					choice.kind === "workspace" &&
					choice.path === "/Users/me/current-notes",
			),
		).toHaveLength(1);
	});

	it("filters workspaces by folder name", () => {
		const choices = buildWorkspaceChoices({
			workspacePath: "/Users/me/current-notes",
			recentWorkspaces: ["/Users/me/client-notes", "/Users/me/project-notes"],
			query: "CLIENT",
		});

		expect(choices.map((choice) => choice.label)).toEqual([
			"client-notes",
			"Add folder...",
		]);
	});

	it("filters workspaces by full path", () => {
		const choices = buildWorkspaceChoices({
			workspacePath: "/Users/me/current-notes",
			recentWorkspaces: [
				"/Users/me/client-notes",
				"/Volumes/Archive/project-notes",
			],
			query: "archive",
		});

		expect(choices.map((choice) => choice.label)).toEqual([
			"project-notes",
			"Add folder...",
		]);
	});

	it("always appends the add folder choice", () => {
		expect(
			buildWorkspaceChoices({
				workspacePath: "/Users/me/current-notes",
				recentWorkspaces: [],
				query: "missing",
			}),
		).toEqual([
			{
				kind: "add-folder",
				label: "Add folder...",
				detail: "Choose another folder to open",
			},
		]);
	});

	it("can omit the add folder choice when embedded in default search results", () => {
		const choices = buildWorkspaceChoices({
			workspacePath: "/Users/me/current-notes",
			recentWorkspaces: ["/Users/me/client-notes"],
			query: "client",
			includeAddFolder: false,
		});

		expect(choices.map((choice) => choice.label)).toEqual(["client-notes"]);
	});
});
