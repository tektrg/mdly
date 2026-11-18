import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeEngine } from "./writingEngine";
import {
	BUILT_IN_TOOLS,
	buildToolPrompt,
	cleanModelOutput,
	listWritingTools,
	parseToolFile,
	resetWritingTool,
	toolsDir,
} from "./writingTools";

let root: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "writing-tools-"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("writing tool files", () => {
	it("seeds all eight built-ins as editable files", async () => {
		const tools = await listWritingTools(root);
		expect(tools.map((t) => t.name)).toEqual([
			"Proofread",
			"Tighten",
			"Clarify",
			"Longer",
			"Shorter",
			"To table",
			"To bullets",
			"Simplify",
		]);
		expect(BUILT_IN_TOOLS).toHaveLength(8);
		const text = await fs.readFile(
			path.join(toolsDir(root), "proofread.md"),
			"utf8",
		);
		expect(text).toMatch(/^---\nname: Proofread\nengine: local\n---\n/);
	});

	it("never overwrites an edited prompt; reset restores the default", async () => {
		await listWritingTools(root);
		const file = path.join(toolsDir(root), "tighten.md");
		await fs.writeFile(
			file,
			"---\nname: Tighten\nengine: agent\n---\nMy own prompt\n",
		);
		let tight = (await listWritingTools(root)).find((t) => t.id === "tighten");
		expect(tight?.prompt).toBe("My own prompt");
		expect(tight?.engine).toBe("agent");
		await resetWritingTool(root, "tighten");
		tight = (await listWritingTools(root)).find((t) => t.id === "tighten");
		expect(tight?.engine).toBe("local");
		expect(tight?.prompt).toMatch(/tighter/);
		await expect(resetWritingTool(root, "nope")).rejects.toThrow();
	});

	it("lists custom tool files too, defaulting engine to agent", async () => {
		await fs.mkdir(toolsDir(root), { recursive: true });
		await fs.writeFile(
			path.join(toolsDir(root), "voice.md"),
			"---\nname: My voice\n---\nWrite like me.",
		);
		const voice = (await listWritingTools(root)).find((t) => t.id === "voice");
		expect(voice).toMatchObject({
			name: "My voice",
			engine: "agent",
			builtIn: false,
		});
		expect(parseToolFile("x", "no front matter")).toMatchObject({
			name: "x",
			prompt: "no front matter",
		});
	});

	it("fences hostile selected text as data", () => {
		const prompt = buildToolPrompt("Fix it.", "$(echo INJECTED)");
		expect(prompt).toContain("<<<TEXT\n$(echo INJECTED)\nTEXT>>>");
	});

	it("cleans common model wrapping", () => {
		expect(cleanModelOutput("Here is the text:\nHello there.")).toBe(
			"Hello there.",
		);
		expect(cleanModelOutput("```\nA\n```")).toBe("A");
		expect(cleanModelOutput('"Quoted."')).toBe("Quoted.");
	});
});

describe("writing engine", () => {
	it("fake engine returns its response", async () => {
		const engine = createFakeEngine({ respond: () => "out" });
		expect(await engine.run("p")).toEqual({ status: "done", text: "out" });
	});
});
