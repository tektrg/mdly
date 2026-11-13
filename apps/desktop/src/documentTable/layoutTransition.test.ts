// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopApi, loadStoreActions } from "../store/storeTestHarness";
import {
	anchoredScrollTop,
	runLayoutTransition,
	takeScrollAnchor,
} from "./layoutTransition";

vi.mock("sonner", () => ({
	toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

type Doc = { startViewTransition?: unknown };

/** Fake View Transitions: queues callbacks so a test controls when they run. */
function installFakeViewTransitions() {
	const queued: (() => void)[] = [];
	(document as unknown as Doc).startViewTransition = (update: () => void) => {
		let done: () => void = () => {};
		const updateCallbackDone = new Promise<void>((resolve) => {
			done = resolve;
		});
		queued.push(() => {
			update();
			done();
		});
		return { updateCallbackDone };
	};
	return {
		flush: () => {
			for (const run of queued.splice(0)) run();
		},
	};
}

function stubReducedMotion(reduce: boolean) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: reduce && query.includes("reduce"),
	}));
}

afterEach(() => {
	delete (document as unknown as Doc).startViewTransition;
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
	takeScrollAnchor();
});

describe("anchoredScrollTop", () => {
	const base = { rowHeight: 40, clientHeight: 400, contentHeight: 40_000 };

	it("keeps the row at the offset it had where the user clicked", () => {
		expect(anchoredScrollTop({ ...base, index: 500, offset: 120 })).toBe(
			500 * 40 - 120,
		);
	});

	it("pulls an offset that would hide the row back into the viewport", () => {
		expect(anchoredScrollTop({ ...base, index: 500, offset: 9999 })).toBe(
			500 * 40 - 360,
		);
		expect(anchoredScrollTop({ ...base, index: 500, offset: -50 })).toBe(
			500 * 40,
		);
	});

	it("clamps to the list's scrollable range at both ends", () => {
		expect(anchoredScrollTop({ ...base, index: 1, offset: 200 })).toBe(0);
		expect(anchoredScrollTop({ ...base, index: 999, offset: 0 })).toBe(
			40_000 - 400,
		);
	});
});

describe("runLayoutTransition", () => {
	it("records the clicked row's offset as a one-shot anchor", () => {
		document.body.innerHTML =
			'<div role="rowgroup"><button data-document-path="/ws/a.md"></button></div>';
		runLayoutTransition(() => {}, "/ws/a.md");
		expect(takeScrollAnchor()).toEqual({ path: "/ws/a.md", offset: 0 });
		expect(takeScrollAnchor()).toBeNull();
	});

	it("switches instantly under prefers-reduced-motion", () => {
		stubReducedMotion(true);
		const transitions = installFakeViewTransitions();
		const update = vi.fn();
		runLayoutTransition(update);
		expect(update).toHaveBeenCalledTimes(1);
		transitions.flush();
		expect(update).toHaveBeenCalledTimes(1);
	});

	it("defers the layout write into the view transition otherwise", async () => {
		stubReducedMotion(false);
		const transitions = installFakeViewTransitions();
		const update = vi.fn();
		const done = runLayoutTransition(update);
		expect(update).not.toHaveBeenCalled();
		transitions.flush();
		await done;
		expect(update).toHaveBeenCalledTimes(1);
	});
});

describe("table <-> peek split through the store", () => {
	it("rapid clicks mid-transition land on the last document clicked", async () => {
		stubReducedMotion(false);
		const transitions = installFakeViewTransitions();
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue("# doc");
		const { loadPath, openWorkspace, viewerStore } =
			await loadStoreActions(api);
		await openWorkspace("/ws");

		const first = loadPath("/ws/a.md");
		const second = loadPath("/ws/b.md");
		transitions.flush();
		await Promise.all([first, second]);

		expect(viewerStore.get().requestedPath).toBe("/ws/b.md");
		expect(viewerStore.get().currentPath).toBe("/ws/b.md");
	});

	it("closing animates back to the table only once the transition runs", async () => {
		stubReducedMotion(false);
		const api = createDesktopApi();
		api.readFileText.mockResolvedValue("# doc");
		const { loadPath, openWorkspace, closeDocumentToTable, viewerStore } =
			await loadStoreActions(api);
		await openWorkspace("/ws");
		await loadPath("/ws/a.md"); // no fake installed yet: instant open
		const transitions = installFakeViewTransitions();

		const closing = closeDocumentToTable();
		await vi.waitFor(() => {
			transitions.flush();
			expect(viewerStore.get().requestedPath).toBeNull();
		});
		await closing;
	});
});
