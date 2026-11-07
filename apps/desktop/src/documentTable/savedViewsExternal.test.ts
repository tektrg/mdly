/**
 * Saved views outside the app (R11-R14): the app's real saved-views store over
 * the real `views.json` writer (table-core/node), with views made by the same
 * command the `hubble views` CLI and the MCP tools run.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sanitizeSavedView, serializeViewsFile } from "@tektrg/table-core";
import {
	createWorkspaceViewStore,
	runViewCommand,
	viewsFilePath,
} from "@tektrg/table-core/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchesFolderFilters } from "./properties/documentViews";

let ws: string;
beforeEach(async () => {
	ws = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "mdly-ext-views-")),
	);
	await fs.mkdir(path.join(ws, "a/deep"), { recursive: true });
});
afterEach(async () => {
	vi.unstubAllGlobals();
	await fs.rm(ws, { recursive: true, force: true });
});

async function load() {
	vi.resetModules();
	vi.stubGlobal("localStorage", {
		getItem: () => null,
		setItem: () => {},
	});
	const fileStore = await import("./documentViewsFileStore");
	fileStore.setViewStoreFactoryForTest((root) =>
		createWorkspaceViewStore(root),
	);
	const tableStore = await import("./documentTableStore");
	const state = await import("../store/state");
	state.workspacePathStore.set(ws);
	// The workspace switch starts the load; wait for it (and any follow-up) to settle.
	for (let i = 0; i < 200; i += 1) {
		if (fileStore.getWorkspaceSavedViews(ws).status !== "loading") break;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return { ...fileStore, ...tableStore, ...state };
}

const onDisk = async () =>
	JSON.parse(await fs.readFile(viewsFilePath(ws), "utf8")) as {
		views: Record<string, unknown>[];
	};

/** A views.json exactly as the pre-move app (table-core 1.3 + desktop sanitizer) saved it. */
const PRE_MOVE_FIXTURE = `{
  "version": 1,
  "views": [
    {
      "board": {
        "cardProperties": null,
        "columnColors": {
          "open": "green"
        },
        "columnOrder": [
          "open"
        ],
        "hiddenColumns": [],
        "hideEmptyColumns": false
      },
      "boardField": "prop:status",
      "calendarField": null,
      "filters": [
        {
          "kind": "folder",
          "path": "a"
        },
        {
          "fieldId": "prop:tag",
          "kind": "is",
          "value": "x"
        },
        {
          "fieldId": "file:words",
          "kind": "has"
        }
      ],
      "groupBy": "prop:status",
      "id": "legacy-1",
      "name": "Board",
      "propertyColumns": [
        "prop:status"
      ],
      "sort": {
        "column": "name",
        "direction": "asc"
      },
      "viewType": "board"
    }
  ]
}
`;

describe("views made outside the app (R11-R14)", () => {
	it("a CLI-created view loads in the app with identical folders/group/filters (roundtrip-cli-to-app, R2-cli-to-app)", async () => {
		const cli = await runViewCommand(ws, {
			kind: "create",
			name: "Tagged",
			folders: ["a"],
			groupBy: "status",
			filters: ["tag=x"],
		});
		if (!("record" in cli)) throw new Error(JSON.stringify(cli));
		const m = await load();
		const views = m.getSavedViews(ws);
		expect(views).toHaveLength(1);
		expect(views[0]).toEqual(sanitizeSavedView(cli.record));
		expect(views[0]).toMatchObject({
			name: "Tagged",
			groupBy: "prop:status",
			filters: [
				{ kind: "folder", path: "a" },
				{ fieldId: "prop:tag", kind: "is", value: "x" },
			],
		});
		expect(matchesFolderFilters("a/deep/doc.md", views[0].filters)).toBe(true);
		expect(matchesFolderFilters("b/doc.md", views[0].filters)).toBe(false);
	});

	it("an app-saved view is listed by the CLI with equal fields (roundtrip-app-to-cli)", async () => {
		const m = await load();
		const id = m.saveCurrentViewAs("From app");
		await m.flushSavedViews(ws);
		const listed = await runViewCommand(ws, { kind: "list" });
		if (!("views" in listed)) throw new Error("list failed");
		expect(listed.views).toHaveLength(1);
		expect(listed.views[0]).toMatchObject({ id, name: "From app" });
		expect(sanitizeSavedView(listed.views[0])).toEqual(m.getSavedViews(ws)[0]);
	});

	it("pre-move views load the same and re-save byte-identically (R1-app-views-unchanged, R11)", async () => {
		await fs.mkdir(path.join(ws, ".hubble"));
		await fs.writeFile(viewsFilePath(ws), PRE_MOVE_FIXTURE);
		const m = await load();
		const fixture = JSON.parse(PRE_MOVE_FIXTURE).views[0];
		expect(m.getSavedViews(ws)).toEqual([fixture]);
		// Force a real save of the unchanged views.
		m.updateSavedViews(ws, (views) => views.map((v) => ({ ...v })));
		await m.flushSavedViews(ws);
		expect(await fs.readFile(viewsFilePath(ws), "utf8")).toBe(PRE_MOVE_FIXTURE);
	});

	it("a stale app save is refused and the CLI view survives (stale-guard, EC6, R5)", async () => {
		const m = await load();
		const id = m.saveCurrentViewAs("Mine");
		await m.flushSavedViews(ws);
		await runViewCommand(ws, { kind: "create", name: "From CLI" });
		m.updateSavedViews(ws, (views) =>
			views.map((v) => (v.id === id ? { ...v, name: "Mine renamed" } : v)),
		);
		await m.flushSavedViews(ws);
		const names = (await onDisk()).views.map((v) => v.name);
		expect(names).toEqual(["Mine", "From CLI"]);
		expect(m.getWorkspaceSavedViews(ws).notice).toMatchObject({
			kind: "conflict",
		});
		expect(m.getSavedViews(ws).map((v) => v.name)).toEqual([
			"Mine",
			"From CLI",
		]);
	});

	it("window-focus refresh picks up CLI views, keeps the selection, and falls back when the active view is deleted (R14, QA4-c, QA10)", async () => {
		const m = await load();
		const id = m.saveCurrentViewAs("A");
		await m.flushSavedViews(ws);
		expect(m.getActiveSavedView()?.id).toBe(id);
		await runViewCommand(ws, { kind: "create", name: "B" });
		await m.refreshWorkspaceSavedViews(ws);
		expect(m.getSavedViews(ws).map((v) => v.name)).toEqual(["A", "B"]);
		expect(m.getActiveSavedView()?.id).toBe(id);
		await runViewCommand(ws, { kind: "delete", target: "A" });
		await m.refreshWorkspaceSavedViews(ws);
		expect(m.getSavedViews(ws).map((v) => v.name)).toEqual(["B"]);
		expect(m.getActiveSavedView()).toBeNull();
	});

	it("refresh after the app's own save changes nothing: no reload, no notice, one write (QA3-c, QA8-b, QA11)", async () => {
		const m = await load();
		m.saveCurrentViewAs("A");
		await m.flushSavedViews(ws);
		const before = await fs.stat(viewsFilePath(ws));
		const states: string[] = [];
		const unsubscribe = m.savedViewsStore.subscribe((all) =>
			states.push(all[ws]?.status ?? "none"),
		);
		const initial = states.length; // the store may call back once on subscribe
		await m.refreshWorkspaceSavedViews(ws);
		await m.refreshWorkspaceSavedViews(ws);
		unsubscribe();
		states.splice(0, initial);
		expect(states).toEqual([]);
		expect(m.getWorkspaceSavedViews(ws).notice).toBeNull();
		expect((await fs.stat(viewsFilePath(ws))).mtimeMs).toBe(before.mtimeMs);
	});

	it("a pending in-app edit is saved before the refresh, not replaced", async () => {
		const m = await load();
		const id = m.saveCurrentViewAs("A");
		await m.flushSavedViews(ws);
		m.renameSavedView(id as string, "A2");
		await m.refreshWorkspaceSavedViews(ws);
		expect((await onDisk()).views.map((v) => v.name)).toEqual(["A2"]);
		expect(m.getSavedViews(ws).map((v) => v.name)).toEqual(["A2"]);
	});

	it("serializes CLI and app records the same way (one format)", async () => {
		const cli = await runViewCommand(ws, { kind: "create", name: "X" });
		if (!("file" in cli)) throw new Error("create failed");
		expect(await fs.readFile(viewsFilePath(ws), "utf8")).toBe(
			serializeViewsFile(cli.file),
		);
	});
});
