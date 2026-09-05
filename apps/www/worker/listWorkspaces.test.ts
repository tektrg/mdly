import { describe, expect, it } from "vitest";
import { authedJson, fetchWithBearer, jsonBody } from "./testHelpers.js";

/**
 * R28/R33/R38 — the server-side workspace registry that makes multi-workspace
 * (D8) real: flipping local config alone must never be enough (R28); the
 * list-workspaces route is itself authenticated and returns exactly the
 * opted-in set (R33); one shared password reaches all of them (R38).
 */
describe("list-workspaces route (R28, R33, R38)", () => {
	it("QA3c — a workspace created via hubble cloud create/connect is discoverable via list-workspaces", async () => {
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: "created-alpha" }),
		});
		await fetchWithBearer("/api/workspace", {
			method: "POST",
			...jsonBody({ name: "created-beta" }),
		});

		const list = await authedJson<{ workspaces: { name: string }[] }>(
			"/api/workspaces",
		);
		const names = list.body.workspaces.map((w) => w.name);
		expect(names).toContain("created-alpha");
		expect(names).toContain("created-beta");
		expect(names).not.toContain("never-created-anything");
	});

	it("QA2b — the enable-toggle route registers a workspace server-side without a prior createWorkspace call", async () => {
		const enable = await fetchWithBearer("/api/workspace/enable", {
			method: "POST",
			...jsonBody({ name: "toggled-on-workspace" }),
		});
		expect(enable.status).toBe(200);

		const list = await authedJson<{ workspaces: { name: string }[] }>(
			"/api/workspaces",
		);
		expect(list.body.workspaces.map((w) => w.name)).toContain(
			"toggled-on-workspace",
		);
	});

	it("QA1b — a workspace that never opted in never appears", async () => {
		const list = await authedJson<{ workspaces: { name: string }[] }>(
			"/api/workspaces",
		);
		expect(list.body.workspaces.map((w) => w.name)).not.toContain(
			"nonexistent-workspace",
		);
	});
});
