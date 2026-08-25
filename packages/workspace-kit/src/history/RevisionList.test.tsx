// @vitest-environment happy-dom
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Revision, RevisionList } from "./RevisionList";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function revision(overrides: Partial<Revision>): Revision {
	return {
		id: "r1",
		hash: "hash1",
		at: 0,
		by: { kind: "human", id: "local" },
		cause: "manual",
		bytes: 10,
		prev: null,
		...overrides,
	};
}

describe("RevisionList", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	function render(props: Parameters<typeof RevisionList>[0]) {
		act(() => {
			root.render(<RevisionList {...props} />);
		});
	}

	function rowIds() {
		return Array.from(container.querySelectorAll("[data-revision-row]")).map(
			(el) => el.getAttribute("data-revision-id"),
		);
	}

	// R9: revisions render in exactly the given array order, never re-sorted by
	// `at` -- fixture is deliberately out of timestamp order in both directions.
	it("renders revisions in the given array order, not sorted by `at`, with correct cause labels", () => {
		const revisions: Revision[] = [
			revision({ id: "mid", at: 50, cause: "external-write" }),
			revision({ id: "earliest", at: 10, cause: "manual" }),
			revision({ id: "latest", at: 100, cause: "idle-session" }),
		];

		render({
			revisions,
			selectedRevisionId: null,
			onSelectRevision: vi.fn(),
		});

		expect(rowIds()).toEqual(["mid", "earliest", "latest"]);

		const labels = Array.from(
			container.querySelectorAll("[data-revision-row]"),
		).map((row) => row.querySelector("span")?.textContent);
		expect(labels).toEqual([
			"Edited outside the app",
			"You reviewed and merged this",
			"Autosaved",
		]);
	});

	// R16: zero revisions must render a clean empty state, never throw or block.
	it("renders a 'no history yet' empty state for zero revisions, without throwing", () => {
		expect(() => {
			render({
				revisions: [],
				selectedRevisionId: null,
				onSelectRevision: vi.fn(),
			});
		}).not.toThrow();

		expect(container.querySelector("[data-timeline-empty]")).not.toBeNull();
		expect(container.querySelector("[data-revision-row]")).toBeNull();
	});

	it("marks the currently-viewed revision as selected and reports clicks", () => {
		const onSelectRevision = vi.fn();
		render({
			revisions: [revision({ id: "r1" }), revision({ id: "r2" })],
			selectedRevisionId: "r2",
			onSelectRevision,
		});

		const rows = container.querySelectorAll<HTMLButtonElement>(
			"[data-revision-row]",
		);
		expect(rows[0]?.getAttribute("aria-pressed")).toBe("false");
		expect(rows[1]?.getAttribute("aria-pressed")).toBe("true");

		act(() => rows[0]?.click());
		expect(onSelectRevision).toHaveBeenCalledWith("r1");
	});

	// Regression guard: the list must keep its own bounded, independently
	// scrolling region so a long history can't overflow the panel (this was
	// the root cause of a prior bug where a long list pushed the diff out of
	// view entirely -- now that the diff renders in a separate pane, the list
	// still needs its own scroll boundary within the side panel).
	it("gives the list its own scrollable region instead of letting it grow unbounded", () => {
		const revisions: Revision[] = Array.from({ length: 20 }, (_, i) =>
			revision({ id: `r${i}`, at: i, cause: "external-write" }),
		);

		render({
			revisions,
			selectedRevisionId: null,
			onSelectRevision: vi.fn(),
		});

		const list = container.querySelector("[data-revision-list]");
		expect(list?.className).toMatch(/\boverflow-y-auto\b/);
		expect(list?.className).toMatch(/\bmin-h-0\b/);
		expect(list?.className).toMatch(/\bflex-1\b/);
	});
});
