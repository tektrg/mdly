// @vitest-environment happy-dom
import { act } from "react";
// @ts-expect-error The UI package does not ship react-dom/client types for tests.
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ReadRevisionContentResult,
	RevisionDiffView,
} from "./RevisionDiffView";
import type { Revision } from "./RevisionList";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom does not implement scrollIntoView/scroll listening internals
// DiffChangeRail touches indirectly via getBoundingClientRect -- stub it so
// mounting doesn't throw.
Element.prototype.scrollIntoView = vi.fn();

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

describe("RevisionDiffView", () => {
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

	function render(props: Parameters<typeof RevisionDiffView>[0]) {
		act(() => {
			root.render(<RevisionDiffView {...props} />);
		});
	}

	// R17: an unreadable stored revision degrades to a distinct "unavailable"
	// state, never a throw and never silently treated as empty.
	it("shows a distinct unavailable state when the revision read resolves {status:'unavailable'}", async () => {
		const onReadRevisionContent = vi.fn(
			async (): Promise<ReadRevisionContentResult> => ({
				status: "unavailable",
			}),
		);

		render({
			revision: revision({ id: "r1" }),
			currentContent: "current",
			onReadRevisionContent,
			onBack: vi.fn(),
		});
		await flush();

		expect(onReadRevisionContent).toHaveBeenCalledWith("r1");
		expect(
			container.querySelector("[data-revision-unavailable]"),
		).not.toBeNull();
	});

	// R10: the viewed revision diffs against the CURRENT content, not just the
	// immediately-prior revision.
	it("diffs the viewed revision's content against currentContent", async () => {
		const onReadRevisionContent = vi.fn(
			async (): Promise<ReadRevisionContentResult> => ({
				status: "ok",
				content: "line1\nold line\nline3\n",
			}),
		);

		render({
			revision: revision({ id: "r1" }),
			currentContent: "line1\nnew line\nline3\n",
			onReadRevisionContent,
			onBack: vi.fn(),
		});
		await flush();

		const regionTypes = Array.from(
			container.querySelectorAll("[data-revision-diff] [data-region-type]"),
		).map((el) => el.getAttribute("data-region-type"));
		expect(regionTypes).toEqual(["unchanged", "removed", "added", "unchanged"]);
	});

	it("re-fetches when the viewed revision changes and calls onBack from the header button", async () => {
		const onReadRevisionContent = vi.fn(
			async (): Promise<ReadRevisionContentResult> => ({
				status: "ok",
				content: "x",
			}),
		);
		const onBack = vi.fn();

		render({
			revision: revision({ id: "r1" }),
			currentContent: "x",
			onReadRevisionContent,
			onBack,
		});
		await flush();
		expect(onReadRevisionContent).toHaveBeenCalledWith("r1");

		render({
			revision: revision({ id: "r2" }),
			currentContent: "x",
			onReadRevisionContent,
			onBack,
		});
		await flush();
		expect(onReadRevisionContent).toHaveBeenCalledWith("r2");

		const backButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Back to editor",
		);
		act(() => backButton?.click());
		expect(onBack).toHaveBeenCalledTimes(1);
	});
});
