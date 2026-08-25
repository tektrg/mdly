// @vitest-environment happy-dom
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ReadRevisionContentResult,
	type Revision,
	RevisionTimeline,
} from "./RevisionTimeline";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

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

describe("RevisionTimeline", () => {
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

	function render(props: Parameters<typeof RevisionTimeline>[0]) {
		act(() => {
			root.render(<RevisionTimeline {...props} />);
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
			currentContent: "current",
			onReadRevisionContent: vi.fn(),
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
				currentContent: "anything",
				onReadRevisionContent: vi.fn(),
			});
		}).not.toThrow();

		expect(container.querySelector("[data-timeline-empty]")).not.toBeNull();
		expect(container.querySelector("[data-revision-row]")).toBeNull();
	});

	// R17: an unreadable stored revision degrades to a distinct "unavailable"
	// state, never a throw and never silently treated as empty.
	it("shows a distinct unavailable state when a revision read resolves {status:'unavailable'}", async () => {
		const onReadRevisionContent = vi.fn(
			async (): Promise<ReadRevisionContentResult> => ({
				status: "unavailable",
			}),
		);

		render({
			revisions: [revision({ id: "r1" })],
			currentContent: "current",
			onReadRevisionContent,
		});

		const row = container.querySelector<HTMLButtonElement>(
			"[data-revision-row]",
		);
		act(() => row?.click());
		await flush();

		expect(onReadRevisionContent).toHaveBeenCalledWith("r1");
		expect(
			container.querySelector("[data-revision-unavailable]"),
		).not.toBeNull();
	});

	// R10: selecting an older revision diffs it against the CURRENT content,
	// not just the immediately-prior revision.
	it("diffs a selected revision's content against currentContent", async () => {
		const onReadRevisionContent = vi.fn(
			async (): Promise<ReadRevisionContentResult> => ({
				status: "ok",
				content: "line1\nold line\nline3\n",
			}),
		);

		render({
			revisions: [revision({ id: "r1" })],
			currentContent: "line1\nnew line\nline3\n",
			onReadRevisionContent,
		});

		const row = container.querySelector<HTMLButtonElement>(
			"[data-revision-row]",
		);
		act(() => row?.click());
		await flush();

		const regionTypes = Array.from(
			container.querySelectorAll("[data-revision-diff] [data-region-type]"),
		).map((el) => el.getAttribute("data-region-type"));
		expect(regionTypes).toEqual(["unchanged", "removed", "added", "unchanged"]);
	});

	// Regression guard: a long revision list must not be able to push the
	// selected diff out of the dialog's visible area (a selected revision's
	// diff going missing behind a tall, unbounded list, with no visible
	// scrollbar hinting there's more below). The list needs its own bounded,
	// independently-scrolling region so the diff pane always keeps space.
	it("caps the revision list to its own scrollable region instead of letting it grow unbounded", () => {
		const revisions: Revision[] = Array.from({ length: 20 }, (_, i) =>
			revision({ id: `r${i}`, at: i, cause: "external-write" }),
		);

		render({
			revisions,
			currentContent: "current",
			onReadRevisionContent: vi.fn(),
		});

		const list = container.querySelector("[data-revision-list]");
		expect(list?.className).toMatch(/\boverflow-y-auto\b/);
		expect(list?.className).toMatch(/\bmax-h-/);
	});
});
