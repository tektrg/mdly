import { describe, expect, it } from "vitest";
import {
	createInitialHistory,
	MAX_NAV_HISTORY,
	navigateBack,
	navigateForward,
	pushNavigation,
	removePathFromHistory,
	replaceCurrentInHistory,
	TABLE_NAV_ENTRY,
	updatePathInHistory,
	updatePrefixInHistory,
} from "./docNavigationHistory";

describe("docNavigationHistory reducers", () => {
	it("initializes history with empty stacks", () => {
		const history = createInitialHistory("/workspace/first.md");
		expect(history.back).toEqual([]);
		expect(history.forward).toEqual([]);
		expect(history.current).toBe("/workspace/first.md");
	});

	it("pushes a new document and records previous current in back stack", () => {
		let history = createInitialHistory("/workspace/a.md");
		history = pushNavigation(history, "/workspace/b.md");

		expect(history.back).toEqual(["/workspace/a.md"]);
		expect(history.forward).toEqual([]);
		expect(history.current).toBe("/workspace/b.md");

		history = pushNavigation(history, "/workspace/c.md");
		expect(history.back).toEqual(["/workspace/a.md", "/workspace/b.md"]);
		expect(history.forward).toEqual([]);
		expect(history.current).toBe("/workspace/c.md");
	});

	it("ignores consecutive navigations to the exact same path", () => {
		let history = createInitialHistory("/workspace/a.md");
		history = pushNavigation(history, "/workspace/a.md");

		expect(history.back).toEqual([]);
		expect(history.current).toBe("/workspace/a.md");

		history = pushNavigation(history, "/workspace/b.md");
		history = pushNavigation(history, "/workspace/b.md");
		expect(history.back).toEqual(["/workspace/a.md"]);
		expect(history.current).toBe("/workspace/b.md");
	});

	it("navigates back through history, transferring to forward stack", () => {
		let history = createInitialHistory("/workspace/a.md");
		history = pushNavigation(history, "/workspace/b.md");
		history = pushNavigation(history, "/workspace/c.md");

		const back1 = navigateBack(history);
		expect(back1).not.toBeNull();
		expect(back1?.targetPath).toBe("/workspace/b.md");
		expect(back1?.nextHistory.back).toEqual(["/workspace/a.md"]);
		expect(back1?.nextHistory.forward).toEqual(["/workspace/c.md"]);
		expect(back1?.nextHistory.current).toBe("/workspace/b.md");

		history = back1?.nextHistory ?? history;
		const back2 = navigateBack(history);
		expect(back2).not.toBeNull();
		expect(back2?.targetPath).toBe("/workspace/a.md");
		expect(back2?.nextHistory.back).toEqual([]);
		expect(back2?.nextHistory.forward).toEqual([
			"/workspace/b.md",
			"/workspace/c.md",
		]);
		expect(back2?.nextHistory.current).toBe("/workspace/a.md");

		// At the root of history, back returns null
		history = back2?.nextHistory ?? history;
		const back3 = navigateBack(history);
		expect(back3).toBeNull();
	});

	it("navigates forward through history, transferring to back stack", () => {
		let history = createInitialHistory("/workspace/a.md");
		history = pushNavigation(history, "/workspace/b.md");
		history = pushNavigation(history, "/workspace/c.md");

		// Go back twice
		history = navigateBack(history)?.nextHistory ?? history;
		history = navigateBack(history)?.nextHistory ?? history;

		expect(history.current).toBe("/workspace/a.md");
		expect(history.forward).toEqual(["/workspace/b.md", "/workspace/c.md"]);

		const fwd1 = navigateForward(history);
		expect(fwd1).not.toBeNull();
		expect(fwd1?.targetPath).toBe("/workspace/b.md");
		expect(fwd1?.nextHistory.back).toEqual(["/workspace/a.md"]);
		expect(fwd1?.nextHistory.forward).toEqual(["/workspace/c.md"]);
		expect(fwd1?.nextHistory.current).toBe("/workspace/b.md");

		history = fwd1?.nextHistory ?? history;
		const fwd2 = navigateForward(history);
		expect(fwd2).not.toBeNull();
		expect(fwd2?.targetPath).toBe("/workspace/c.md");
		expect(fwd2?.nextHistory.back).toEqual([
			"/workspace/a.md",
			"/workspace/b.md",
		]);
		expect(fwd2?.nextHistory.forward).toEqual([]);
		expect(fwd2?.nextHistory.current).toBe("/workspace/c.md");

		// At the end of history, forward returns null
		history = fwd2?.nextHistory ?? history;
		const fwd3 = navigateForward(history);
		expect(fwd3).toBeNull();
	});

	it("clears forward history when a new navigation occurs after going back (branching)", () => {
		let history = createInitialHistory("/workspace/a.md");
		history = pushNavigation(history, "/workspace/b.md");
		history = pushNavigation(history, "/workspace/c.md");

		// Go back to b
		history = navigateBack(history)?.nextHistory ?? history;
		expect(history.forward).toEqual(["/workspace/c.md"]);

		// Now visit d
		history = pushNavigation(history, "/workspace/d.md");
		expect(history.back).toEqual(["/workspace/a.md", "/workspace/b.md"]);
		expect(history.forward).toEqual([]);
		expect(history.current).toBe("/workspace/d.md");
	});

	it("replaces current document without disturbing back or forward stacks", () => {
		let history = createInitialHistory("/workspace/a.md");
		history = pushNavigation(history, "/workspace/b.md");
		history = replaceCurrentInHistory(history, "/workspace/b-renamed.md");

		expect(history.back).toEqual(["/workspace/a.md"]);
		expect(history.forward).toEqual([]);
		expect(history.current).toBe("/workspace/b-renamed.md");
	});

	it("updates path across back, forward, and current when a file is renamed", () => {
		let history = createInitialHistory("/workspace/a.md");
		history = pushNavigation(history, "/workspace/b.md");
		history = pushNavigation(history, "/workspace/c.md");
		history = navigateBack(history)?.nextHistory ?? history;

		// Current is b, back is [a], forward is [c]
		// Rename a.md -> a-new.md and c.md -> c-new.md
		history = updatePathInHistory(
			history,
			"/workspace/a.md",
			"/workspace/a-new.md",
		);
		history = updatePathInHistory(
			history,
			"/workspace/c.md",
			"/workspace/c-new.md",
		);

		expect(history.back).toEqual(["/workspace/a-new.md"]);
		expect(history.current).toBe("/workspace/b.md");
		expect(history.forward).toEqual(["/workspace/c-new.md"]);
	});

	it("updates folder prefix across back, forward, and current when a folder is moved", () => {
		let history = createInitialHistory("/workspace/docs/a.md");
		history = pushNavigation(history, "/workspace/docs/sub/b.md");
		history = pushNavigation(history, "/workspace/other.md");
		history = navigateBack(history)?.nextHistory ?? history;

		// Move /workspace/docs to /workspace/archive
		history = updatePrefixInHistory(
			history,
			"/workspace/docs",
			"/workspace/archive",
		);

		expect(history.back).toEqual(["/workspace/archive/a.md"]);
		expect(history.current).toBe("/workspace/archive/sub/b.md");
		expect(history.forward).toEqual(["/workspace/other.md"]);
	});

	it("removes deleted file or folder from history stacks", () => {
		let history = createInitialHistory("/workspace/a.md");
		history = pushNavigation(history, "/workspace/docs/b.md");
		history = pushNavigation(history, "/workspace/docs/c.md");
		history = pushNavigation(history, "/workspace/d.md");

		// Delete folder /workspace/docs
		history = removePathFromHistory(history, "/workspace/docs");

		expect(history.back).toEqual(["/workspace/a.md"]);
		expect(history.current).toBe("/workspace/d.md");
	});

	it("caps history length to MAX_NAV_HISTORY", () => {
		let history = createInitialHistory("/workspace/doc-0.md");
		for (let i = 1; i <= MAX_NAV_HISTORY + 10; i++) {
			history = pushNavigation(history, `/workspace/doc-${i}.md`);
		}

		expect(history.back.length).toBe(MAX_NAV_HISTORY);
		expect(history.back[0]).toBe("/workspace/doc-10.md");
		expect(history.current).toBe(`/workspace/doc-${MAX_NAV_HISTORY + 10}.md`);
	});
});

describe("workspace-scoped navigation history", () => {
	it("isolates history between different workspace folders", async () => {
		const {
			clearDocNavigationHistory,
			getDocNavigationHistory,
			recordDocNavigation,
		} = await import("./docNavigationHistory");

		clearDocNavigationHistory();

		// Workspace 1
		recordDocNavigation("/ws1/doc1.md", { workspacePath: "/ws1" });
		recordDocNavigation("/ws1/doc2.md", { workspacePath: "/ws1" });

		// Workspace 2
		recordDocNavigation("/ws2/intro.md", { workspacePath: "/ws2" });
		recordDocNavigation("/ws2/guide.md", { workspacePath: "/ws2" });

		const ws1History = getDocNavigationHistory("/ws1");
		const ws2History = getDocNavigationHistory("/ws2");

		expect(ws1History.back).toEqual(["/ws1/doc1.md"]);
		expect(ws1History.current).toBe("/ws1/doc2.md");

		expect(ws2History.back).toEqual(["/ws2/intro.md"]);
		expect(ws2History.current).toBe("/ws2/guide.md");
	});

	it("does not leak previous workspace document into newly accessed workspace history", async () => {
		const {
			clearDocNavigationHistory,
			getDocNavigationHistory,
			recordDocNavigation,
		} = await import("./docNavigationHistory");

		clearDocNavigationHistory();

		// Workspace 1 has history
		recordDocNavigation("/ws1/doc1.md", { workspacePath: "/ws1" });
		recordDocNavigation("/ws1/doc2.md", { workspacePath: "/ws1" });

		// Workspace 2 accessed for the first time
		const ws2History = getDocNavigationHistory("/ws2");
		expect(ws2History.current).toBeNull();
		expect(ws2History.back).toEqual([]);
		expect(ws2History.forward).toEqual([]);

		// Record first doc in workspace 2
		recordDocNavigation("/ws2/intro.md", { workspacePath: "/ws2" });
		const updatedWs2 = getDocNavigationHistory("/ws2");
		expect(updatedWs2.back).toEqual([]);
		expect(updatedWs2.current).toBe("/ws2/intro.md");
	});
});

describe("docNavigationHistory table sentinel", () => {
	it("makes the table a real back-stack entry", () => {
		let history = createInitialHistory("/workspace/a.md");
		history = pushNavigation(history, "/workspace/b.md");
		history = pushNavigation(history, TABLE_NAV_ENTRY);

		const back = navigateBack(history);
		expect(back?.targetPath).toBe("/workspace/b.md");
		expect(back?.nextHistory.forward).toEqual([TABLE_NAV_ENTRY]);

		const forward = back ? navigateForward(back.nextHistory) : null;
		expect(forward?.targetPath).toBe(TABLE_NAV_ENTRY);
	});

	it("ignores a repeated push of the sentinel", () => {
		let history = pushNavigation(
			createInitialHistory("/workspace/a.md"),
			TABLE_NAV_ENTRY,
		);
		const afterFirst = history;
		history = pushNavigation(history, TABLE_NAV_ENTRY);

		expect(history).toBe(afterFirst);
		expect(history.back).toEqual(["/workspace/a.md"]);
	});

	it("survives a rename rewrite untouched", () => {
		const history = updatePathInHistory(
			{
				back: ["/workspace/a.md", TABLE_NAV_ENTRY],
				forward: [TABLE_NAV_ENTRY],
				current: TABLE_NAV_ENTRY,
			},
			"/workspace/a.md",
			"/workspace/renamed.md",
		);

		expect(history.back).toEqual(["/workspace/renamed.md", TABLE_NAV_ENTRY]);
		expect(history.forward).toEqual([TABLE_NAV_ENTRY]);
		expect(history.current).toBe(TABLE_NAV_ENTRY);
	});

	it("survives a folder-move prefix rewrite untouched", () => {
		const history = updatePrefixInHistory(
			{
				back: ["/workspace/notes/a.md", TABLE_NAV_ENTRY],
				forward: [],
				current: TABLE_NAV_ENTRY,
			},
			"/workspace/notes",
			"/workspace/archive",
		);

		expect(history.back).toEqual(["/workspace/archive/a.md", TABLE_NAV_ENTRY]);
		expect(history.current).toBe(TABLE_NAV_ENTRY);
	});

	it("survives a delete rewrite untouched, including a folder delete", () => {
		const history = removePathFromHistory(
			{
				back: ["/workspace/notes/a.md", TABLE_NAV_ENTRY],
				forward: ["/workspace/notes/b.md", TABLE_NAV_ENTRY],
				current: TABLE_NAV_ENTRY,
			},
			"/workspace/notes",
		);

		expect(history.back).toEqual([TABLE_NAV_ENTRY]);
		expect(history.forward).toEqual([TABLE_NAV_ENTRY]);
		expect(history.current).toBe(TABLE_NAV_ENTRY);
	});
});
